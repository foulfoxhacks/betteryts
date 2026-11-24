//! Twitch chat over IRC (IRCv3 tags). Parses one line into [`IrcMessage`] and maps chat, cheers,
//! subs and raids to engine events. Lines are untrusted: bounded, control characters rejected.

use bys_core::event::{Event, EventKind, InvalidEvent, Platform, RawEvent, Role, Value};
use std::collections::BTreeMap;

/// Twitch allows 8191 bytes of tags plus a 512-byte message.
pub const MAX_LINE: usize = 8192 + 512;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IrcMessage {
    pub tags: BTreeMap<String, String>,
    /// `login` from `login!login@login.tmi.twitch.tv`, when present.
    pub login: Option<String>,
    pub command: String,
    pub params: Vec<String>,
    pub trailing: Option<String>,
}

/// IRCv3 tag value unescaping.
fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') | Some('n') => {} // never let line breaks into values
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

pub fn parse(line: &str) -> Option<IrcMessage> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() || line.len() > MAX_LINE || line.chars().any(|c| c.is_control()) {
        return None;
    }
    let mut msg = IrcMessage::default();
    let mut rest = line;
    if let Some(r) = rest.strip_prefix('@') {
        let (tags, after) = r.split_once(' ')?;
        for tag in tags.split(';').take(64) {
            let (k, v) = tag.split_once('=').unwrap_or((tag, ""));
            if !k.is_empty() && k.len() <= 64 {
                msg.tags.insert(k.to_owned(), unescape(v));
            }
        }
        rest = after;
    }
    if let Some(r) = rest.strip_prefix(':') {
        let (prefix, after) = r.split_once(' ')?;
        msg.login = prefix.split_once('!').map(|(n, _)| n.to_ascii_lowercase());
        rest = after;
    }
    let (head, trailing) = match rest.split_once(" :") {
        Some((h, t)) => (h, Some(t.to_owned())),
        None => (rest, None),
    };
    let mut parts = head.split(' ').filter(|p| !p.is_empty());
    msg.command = parts.next()?.to_ascii_uppercase();
    msg.params = parts.take(15).map(str::to_owned).collect();
    msg.trailing = trailing;
    Some(msg)
}

fn role(tags: &BTreeMap<String, String>) -> Role {
    let badges = tags.get("badges").map(String::as_str).unwrap_or("");
    if badges.split(',').any(|b| b.starts_with("broadcaster/")) {
        Role::Owner
    } else if tags.get("mod").is_some_and(|m| m == "1") || badges.split(',').any(|b| b.starts_with("moderator/")) {
        Role::Moderator
    } else if tags.get("subscriber").is_some_and(|s| s == "1") {
        Role::Subscriber
    } else {
        Role::Viewer
    }
}

fn num(tags: &BTreeMap<String, String>, k: &str) -> f64 {
    tags.get(k).and_then(|v| v.parse::<u64>().ok()).map_or(0.0, |n| n as f64)
}

/// Map a parsed line to engine events. A cheer is both a chat line and a cheer event.
pub fn to_events(m: &IrcMessage) -> Vec<Result<Event, InvalidEvent>> {
    let Some(user_id) = m.tags.get("user-id").filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())) else {
        return vec![]; // Without Twitch's numeric ID we can't apply per-user limits.
    };
    let login = m.tags.get("login").cloned().or_else(|| m.login.clone()).unwrap_or_default();
    let name = m.tags.get("display-name").filter(|d| !d.is_empty()).cloned().unwrap_or(login);
    let id = m.tags.get("id").cloned().unwrap_or_default();
    let actor = Some((user_id.as_str(), name.as_str(), role(&m.tags)));
    let text = m.trailing.as_deref().unwrap_or("");
    let mut out = Vec::new();
    match m.command.as_str() {
        "PRIVMSG" => {
            out.push(Event::new(
                Platform::Twitch,
                EventKind::Chat,
                RawEvent {
                    id: &format!("twitch-chat-{id}"),
                    actor,
                    text,
                    ..Default::default()
                },
            ));
            let bits = num(&m.tags, "bits");
            if bits > 0.0 {
                out.push(Event::new(
                    Platform::Twitch,
                    EventKind::Cheer,
                    RawEvent {
                        id: &format!("twitch-cheer-{id}"),
                        actor,
                        text,
                        amount: bits,
                        ..Default::default()
                    },
                ));
            }
        }
        "USERNOTICE" => {
            let kind = m.tags.get("msg-id").map(String::as_str).unwrap_or("");
            let (event_kind, amount) = match kind {
                "sub" | "resub" => (EventKind::Subscribe, num(&m.tags, "msg-param-cumulative-months").max(1.0)),
                "subgift" | "anonsubgift" => (EventKind::Subscribe, 1.0),
                "submysterygift" => (EventKind::Subscribe, num(&m.tags, "msg-param-mass-gift-count").max(1.0)),
                "raid" => (EventKind::Raid, num(&m.tags, "msg-param-viewerCount")),
                _ => return out,
            };
            let fields = vec![
                ("type", Value::Text(kind.to_owned())),
                ("tier", Value::Text(m.tags.get("msg-param-sub-plan").cloned().unwrap_or_default())),
            ];
            out.push(Event::new(
                Platform::Twitch,
                event_kind,
                RawEvent {
                    id: &format!("twitch-{kind}-{id}"),
                    actor,
                    text,
                    amount,
                    fields,
                },
            ));
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;

    const CHAT: &str = "@badge-info=;badges=moderator/1;color=#FF0000;display-name=Fox\\sFan;id=abc-1;mod=1;user-id=12345 :foxfan!foxfan@foxfan.tmi.twitch.tv PRIVMSG #sammy :!sr Daft Punk - One More Time";

    #[test]
    fn parses_tags_prefix_and_trailing() {
        let m = parse(CHAT).unwrap();
        assert_eq!(m.command, "PRIVMSG");
        assert_eq!(m.params, vec!["#sammy"]);
        assert_eq!(m.login.as_deref(), Some("foxfan"));
        assert_eq!(m.tags["display-name"], "Fox Fan", "\\s unescaped");
        assert_eq!(m.trailing.as_deref(), Some("!sr Daft Punk - One More Time"));
        assert_eq!(parse("PING :tmi.twitch.tv").unwrap().command, "PING");
    }

    #[test]
    fn chat_and_cheer_map_with_roles() {
        let ev: Vec<Event> = to_events(&parse(CHAT).unwrap()).into_iter().map(Result::unwrap).collect();
        assert_eq!(ev.len(), 1);
        let a = ev[0].actor.clone().unwrap();
        assert_eq!((a.id.as_str(), a.name.as_str(), a.role), ("12345", "Fox Fan", Role::Moderator));
        let cheer = parse("@badges=subscriber/6;bits=100;display-name=Giver;id=c1;subscriber=1;user-id=99 :giver!giver@giver.tmi.twitch.tv PRIVMSG #sammy :Cheer100 great set").unwrap();
        let ev: Vec<Event> = to_events(&cheer).into_iter().map(Result::unwrap).collect();
        assert_eq!((ev[1].kind, ev[1].amount), (EventKind::Cheer, 100.0));
        assert_eq!(ev[1].actor.as_ref().unwrap().role, Role::Subscriber);
    }

    #[test]
    fn subs_and_raids() {
        let raid = parse("@display-name=Raider;id=r1;login=raider;msg-id=raid;msg-param-viewerCount=250;user-id=7 :tmi.twitch.tv USERNOTICE #sammy").unwrap();
        let ev = to_events(&raid).into_iter().next().unwrap().unwrap();
        assert_eq!((ev.kind, ev.amount), (EventKind::Raid, 250.0));
        let resub = parse("@display-name=Fan;id=s1;login=fan;msg-id=resub;msg-param-cumulative-months=12;msg-param-sub-plan=1000;user-id=8 :tmi.twitch.tv USERNOTICE #sammy :a year!").unwrap();
        let ev = to_events(&resub).into_iter().next().unwrap().unwrap();
        assert_eq!((ev.kind, ev.amount), (EventKind::Subscribe, 12.0));
    }

    #[test]
    fn hostile_or_anonymous_lines_are_dropped() {
        assert!(parse(&format!("PRIVMSG #a :{}", "x".repeat(MAX_LINE))).is_none());
        assert!(parse("PRIVMSG #a :hi\u{7}").is_none());
        assert!(parse("").is_none());
        let no_id = parse("@display-name=X;id=1 :x!x@x PRIVMSG #a :hi").unwrap();
        assert!(to_events(&no_id).is_empty(), "no numeric user-id, no event");
        let bad_id = parse("@user-id=12a;id=1 :x!x@x PRIVMSG #a :hi").unwrap();
        assert!(to_events(&bad_id).is_empty());
        assert_eq!(unescape("a\\nb\\rc"), "abc", "escaped line breaks are removed");
    }
}
