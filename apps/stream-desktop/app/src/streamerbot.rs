//! Streamer.bot compatibility (YouTube, Kick and anything else Streamer.bot connects to).
//! The desktop subscribes to Streamer.bot's `General.Custom` broadcasts on its local WebSocket and
//! accepts only BetterYTS's own request contract (`"bys": 1`), sent by the action in
//! docs/stream/streamerbot.md. Loopback only; unknown or malformed messages are ignored.

use bys_core::event::{Event, EventKind, Platform, RawEvent, Role};
use bys_store::{Secrets, Settings};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MAX_MESSAGE: usize = 64 * 1024;

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SbStatus {
    /// "off", "connecting", "connected", "error".
    pub state: String,
    pub last_event: Option<String>,
    pub error: Option<String>,
}

/// A request from the BetterYTS Streamer.bot action: (event, kind, query).
pub fn parse(raw: &str) -> Option<(Event, &'static str, String)> {
    if raw.len() > MAX_MESSAGE {
        return None;
    }
    let v: Value = serde_json::from_str(raw).ok()?;
    if v.pointer("/event/source")?.as_str()? != "General" || v.pointer("/event/type")?.as_str()? != "Custom" {
        return None;
    }
    let d = v.get("data")?;
    if d.get("bys")?.as_u64()? != 1 {
        return None;
    }
    let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or("");
    let platform = match s("platform") {
        "youtube" => Platform::YouTube,
        "kick" => Platform::Kick,
        "twitch" => Platform::Twitch,
        "tiktok" => Platform::TikTok,
        _ => Platform::Local,
    };
    let kind = match s("kind") {
        "video" => "video",
        "shoutout" => "shoutout",
        _ => "song",
    };
    let query: String = s("query").trim().chars().take(512).collect();
    let id = format!("sb-{}", s("eventId"));
    if query.is_empty() || s("eventId").len() < 4 || !s("eventId").bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b)) {
        return None;
    }
    let ev = Event::new(
        platform,
        EventKind::Chat,
        RawEvent {
            id: &id,
            actor: Some((s("userId"), s("user"), Role::Viewer)),
            text: &query,
            ..Default::default()
        },
    )
    .ok()?;
    Some((ev, kind, query))
}

fn run(url: &str, stop: &AtomicBool, mut on: impl FnMut(Event, &'static str, String)) -> Result<(), String> {
    if !bys_tiktok::tikfinity::valid_url(url) || url.starts_with("wss://") {
        return Err("Streamer.bot's address must be ws:// on this computer".into());
    }
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (mut ws, _) = tungstenite::client::connect_with_config(url, Some(config), 0).map_err(|e| format!("Streamer.bot isn't reachable ({e})"))?;
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_ref() {
        s.set_read_timeout(Some(Duration::from_millis(500))).map_err(|e| e.to_string())?;
    }
    let sub = r#"{"request":"Subscribe","id":"bys-sub","events":{"General":["Custom"]}}"#;
    ws.send(tungstenite::Message::text(sub)).map_err(|e| e.to_string())?;
    while !stop.load(Ordering::Relaxed) {
        match ws.read() {
            Ok(tungstenite::Message::Text(t)) => {
                if t.as_str().contains("\"authentication\"") && t.as_str().contains("Hello") {
                    return Err("Streamer.bot WebSocket authentication is on; turn it off for the local server or use the HTTP route".into());
                }
                if let Some((ev, kind, query)) = parse(t.as_str()) {
                    on(ev, kind, query);
                }
            }
            Ok(tungstenite::Message::Close(_)) => return Err("Streamer.bot closed the connection".into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let _ = ws.close(None);
    Ok(())
}

/// Supervised connection while enabled; backs off 5 s → 60 s when Streamer.bot isn't running.
pub fn spawn(settings: Arc<Mutex<Settings>>, secrets: Arc<dyn Secrets>, status: Arc<Mutex<SbStatus>>) {
    let set = |status: &Mutex<SbStatus>, f: &dyn Fn(&mut SbStatus)| {
        if let Ok(mut s) = status.lock() {
            f(&mut s);
        }
    };
    let started = std::thread::Builder::new().name("bys-streamerbot".into()).spawn(move || {
        let mut backoff = 5;
        loop {
            let cfg = settings.lock().map(|s| s.streamerbot.clone()).ok().filter(|c| c.enabled);
            let Some(cfg) = cfg else {
                set(&status, &|s| {
                    *s = SbStatus {
                        state: "off".into(),
                        ..Default::default()
                    }
                });
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            set(&status, &|s| s.state = "connecting".into());
            let stop = Arc::new(AtomicBool::new(false));
            let watcher = {
                let (settings, stop) = (settings.clone(), stop.clone());
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        if !settings.lock().map(|s| s.streamerbot.enabled).unwrap_or(false) {
                            stop.store(true, Ordering::Relaxed);
                        }
                        std::thread::sleep(Duration::from_secs(1));
                    }
                })
            };
            set(&status, &|s| s.state = "connected".into());
            let result = run(&cfg.url, &stop, |ev, kind, query| {
                crate::automation::feed(&ev);
                let line: String = crate::chat::submit(&settings, secrets.as_ref(), &ev, kind, query).chars().take(200).collect();
                set(&status, &|s| s.last_event = Some(line.clone()));
            });
            stop.store(true, Ordering::Relaxed);
            let _ = watcher.join();
            match result {
                Err(e) => {
                    set(&status, &|s| {
                        s.state = "error".into();
                        s.error = Some(e.clone());
                    });
                    std::thread::sleep(Duration::from_secs(backoff));
                    backoff = (backoff * 2).min(60);
                }
                Ok(()) => backoff = 5,
            }
        }
    });
    if let Err(e) = started {
        eprintln!("BetterYTS Stream: Streamer.bot source could not start: {e}");
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn msg(data: &str) -> String {
        format!(r#"{{"timeStamp":"2026-11-25T12:00:00Z","event":{{"source":"General","type":"Custom"}},"data":{data}}}"#)
    }

    #[test]
    fn accepts_only_the_bys_contract() {
        let (ev, kind, q) = parse(&msg(
            r#"{"bys":1,"platform":"youtube","eventId":"yt-abc123","userId":"UCx","user":"Viewer","kind":"song","query":"Daft Punk"}"#,
        ))
        .unwrap();
        assert_eq!(
            (ev.platform, kind, q.as_str(), ev.id.as_str()),
            (Platform::YouTube, "song", "Daft Punk", "sb-yt-abc123")
        );
        assert_eq!(ev.actor.unwrap().id, "UCx");
        assert_eq!(
            parse(&msg(
                r#"{"bys":1,"platform":"kick","eventId":"k-1234","userId":"9","user":"K","kind":"shoutout","query":"hi all"}"#
            ))
            .unwrap()
            .1,
            "shoutout"
        );
        for bad in [
            msg(r#"{"bys":2,"eventId":"x-1234","userId":"1","user":"a","query":"q"}"#),
            msg(r#"{"eventId":"x-1234","userId":"1","user":"a","query":"q"}"#),
            msg(r#"{"bys":1,"eventId":"x-1234","userId":"1","user":"a","query":"  "}"#),
            msg(r#"{"bys":1,"eventId":"bad id!","userId":"1","user":"a","query":"q"}"#),
            msg(r#"{"bys":1,"eventId":"x-1234","userId":"","user":"a","query":"q"}"#),
            r#"{"event":{"source":"Twitch","type":"ChatMessage"},"data":{"bys":1}}"#.to_owned(),
            "x".repeat(MAX_MESSAGE + 1),
        ] {
            assert!(parse(&bad).is_none(), "{bad:.80}");
        }
    }
}
