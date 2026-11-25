//! Shared by every chat source (Twitch, TikFinity, …): chat commands become BetterYTS Stream
//! requests, other events become a short "last trigger" line. The source's own message ID is the
//! request's event ID, so a redelivered message is never queued twice.

use bys_core::event::{Event, EventKind};
use bys_store::{Secret, Secrets, Settings};
use bys_stream_api::{ChatRequest, Client, Credential, HttpTransport};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// `!sr song` → ("song", "song"), `!video q` → video, `!shoutout text` → shoutout.
pub fn chat_command(text: &str) -> Option<(&'static str, String)> {
    let (cmd, rest) = text.trim().split_once(char::is_whitespace)?;
    let kind = match cmd.to_ascii_lowercase().as_str() {
        "!sr" | "!songrequest" => "song",
        "!video" | "!vr" => "video",
        "!shoutout" | "!so" => "shoutout",
        _ => return None,
    };
    let input = rest.trim();
    (!input.is_empty()).then(|| (kind, input.chars().take(512).collect()))
}

/// RFC 3339 UTC timestamp for "now" (civil-from-days, no date library).
pub fn utc_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// One line for the console and Discord presence, or `None` for events that aren't triggers.
pub fn describe(ev: &Event) -> Option<String> {
    let who = ev.actor.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| "Someone".into());
    let gift = ev.fields.get("gift").map(|g| g.to_string()).unwrap_or_else(|| "a gift".into());
    Some(match ev.kind {
        EventKind::Gift => format!("{who} sent {gift}"),
        EventKind::Cheer => format!("{who} cheered {} bits", ev.amount),
        EventKind::Follow => format!("{who} followed"),
        EventKind::Share => format!("{who} shared the stream"),
        EventKind::Subscribe => format!("{who} subscribed"),
        EventKind::Raid => format!("{who} raided with {} viewers", ev.amount),
        EventKind::External => format!("{who} redeemed a reward"),
        _ => return None,
    })
}

/// Send a chat request to BetterYTS Stream; returns the message to show.
pub fn submit(settings: &Mutex<Settings>, secrets: &dyn Secrets, ev: &Event, kind: &str, input: String) -> String {
    let Ok(s) = settings.lock().map(|s| s.clone()) else {
        return "settings unavailable".into();
    };
    let Some(code) = s.session_code else {
        return "No BetterYTS Stream session is connected.".into();
    };
    let Some(cred) = secrets.get(Secret::SessionCredential).ok().flatten().and_then(|c| Credential::new(&c).ok()) else {
        return "Session credential missing.".into();
    };
    let Some(actor) = ev.actor.as_ref() else {
        return "Request without a user.".into();
    };
    let req = ChatRequest {
        event_id: ev.id.clone(),
        platform: ev.platform.as_str().into(),
        user_id: actor.id.clone(),
        display_name: actor.name.clone(),
        input,
        kind: kind.into(),
        occurred_at: utc_now(),
    };
    match Client::new(&s.api_origin, HttpTransport::default()).and_then(|c| c.submit_event(&code, &cred, &req)) {
        Ok(r) => r.message,
        Err(e) => e.to_string(),
    }
}

/// Route one event: a chat command → request; a trigger → `on_trigger(text)`. Returns the line to show.
pub fn route(settings: &Mutex<Settings>, secrets: &dyn Secrets, ev: &Event) -> Option<String> {
    crate::automation::feed(ev);
    if ev.kind == EventKind::Chat {
        let (kind, input) = chat_command(&ev.text)?;
        return Some(submit(settings, secrets, ev, kind, input).chars().take(200).collect());
    }
    describe(ev)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn chat_commands() {
        assert_eq!(
            chat_command("!sr Daft Punk - One More Time"),
            Some(("song", "Daft Punk - One More Time".into()))
        );
        assert_eq!(chat_command("!VIDEO  lofi girl "), Some(("video", "lofi girl".into())));
        assert_eq!(chat_command("!shoutout happy birthday!"), Some(("shoutout", "happy birthday!".into())));
        for none in ["!sr", "!sr   ", "hello !sr x", "!other x"] {
            assert_eq!(chat_command(none), None, "{none}");
        }
    }

    #[test]
    fn utc_now_is_rfc3339() {
        let t = utc_now();
        assert_eq!(t.len(), 20);
        assert!(t.ends_with('Z') && t.as_bytes()[10] == b'T' && t.starts_with("20"));
    }
}
