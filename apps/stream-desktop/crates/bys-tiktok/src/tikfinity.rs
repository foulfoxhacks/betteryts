//! TikTok through TikFinity's local WebSocket (owner's chosen TikTok source: no TikTok login, no
//! signing service). Port of PearConnect's `platforms/tikfinity-ws.js` rules: bounded JSON, flat
//! or nested identities that must agree, numeric user IDs only.
//! Chat shapes are verified against recorded fixtures; gift / like / follow / share / viewer
//! fields follow the event shape TikFinity forwards and need confirming against a live TikFinity.

use crate::{TikTokEvent, User};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const DEFAULT_URL: &str = "ws://127.0.0.1:21213/";
pub const MAX_EVENT: usize = 64 * 1024;

/// TikFinity runs on this machine: only plain or TLS WebSockets to loopback, no credentials or query.
pub fn valid_url(url: &str) -> bool {
    let rest = url.strip_prefix("ws://").or_else(|| url.strip_prefix("wss://")).unwrap_or("");
    let host = rest.trim_end_matches('/');
    !rest.contains(['@', '?', '#'])
        && rest.matches('/').count() <= 1
        && ["127.0.0.1:", "localhost:", "[::1]:"]
            .iter()
            .any(|p| host.starts_with(p) && host[p.len()..].parse::<u16>().is_ok_and(|n| n > 0))
}

fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Supplied values must agree (rejects events with conflicting identities).
fn consistent(values: [Option<String>; 3]) -> Result<Option<String>, &'static str> {
    let supplied: Vec<String> = values.into_iter().flatten().filter(|s| !s.is_empty()).collect();
    if supplied.first().is_some_and(|f| supplied.iter().any(|s| s != f)) {
        return Err("conflicting identities");
    }
    Ok(supplied.into_iter().next())
}

fn user(d: &Value) -> Result<User, &'static str> {
    if d.get("user").is_some_and(|u| !u.is_object()) {
        return Err("invalid nested identity");
    }
    let u = d.get("user");
    let handle = consistent([
        text(d.get("uniqueId")),
        u.and_then(|u| text(u.get("uniqueId"))),
        u.and_then(|u| text(u.get("displayId"))),
    ])?;
    let id = consistent([
        text(d.get("userId")),
        u.and_then(|u| text(u.get("userId"))),
        u.and_then(|u| text(u.get("idStr"))),
    ])?
    .ok_or("missing user id")?;
    if id.is_empty() || id.len() > 30 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("user id must be numeric");
    }
    let clean = |s: String| s.chars().filter(|c| !c.is_control()).take(100).collect::<String>();
    Ok(User {
        id,
        handle: clean(handle.unwrap_or_default()),
        nickname: clean(text(d.get("nickname")).or_else(|| u.and_then(|u| text(u.get("nickname")))).unwrap_or_default()),
    })
}

fn num(d: &Value, k: &str) -> u64 {
    d.get(k)
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}

/// Parse one TikFinity message. `Ok(None)` = an event type we don't use.
pub fn parse(raw: &str) -> Result<Option<TikTokEvent>, &'static str> {
    if raw.len() > MAX_EVENT {
        return Err("event too large");
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| "not JSON")?;
    let kind = v.get("event").and_then(Value::as_str).ok_or("missing event name")?;
    let d = v.get("data").filter(|d| d.is_object()).ok_or("missing data")?;
    let msg_id = consistent([text(d.get("msgId")), d.get("common").and_then(|c| text(c.get("msgId"))), None])?.unwrap_or_default();
    Ok(Some(match kind {
        "chat" => TikTokEvent::Chat {
            msg_id,
            user: user(d)?,
            comment: text(d.get("comment")).unwrap_or_default().chars().take(1024).collect(),
        },
        "gift" => TikTokEvent::Gift {
            msg_id,
            user: user(d)?,
            gift_id: num(d, "giftId"),
            name: text(d.get("giftName")).unwrap_or_default().chars().take(100).collect(),
            diamonds: num(d, "diamondCount"),
            repeat: num(d, "repeatCount").max(1),
            streak_end: num(d, "giftType") != 1 || d.get("repeatEnd").is_some_and(|r| r == &Value::Bool(true) || r.as_u64() == Some(1)),
        },
        "like" => TikTokEvent::Like {
            msg_id,
            user: user(d)?,
            count: num(d, "likeCount"),
            total: num(d, "totalLikeCount"),
        },
        "follow" => TikTokEvent::Follow { msg_id, user: user(d)? },
        "share" => TikTokEvent::Share { msg_id, user: user(d)? },
        "roomUser" => TikTokEvent::ViewerCount(num(d, "viewerCount")),
        "streamEnd" => TikTokEvent::StreamEnd,
        _ => return Ok(None),
    }))
}

/// Read TikFinity until `stop` is set or the connection ends. Malformed events are skipped.
pub fn run(url: &str, stop: &AtomicBool, mut on_event: impl FnMut(TikTokEvent)) -> Result<(), String> {
    if !valid_url(url) || url.starts_with("wss://") {
        return Err("TikFinity's address must be ws:// on this computer".into());
    }
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_EVENT))
        .max_frame_size(Some(MAX_EVENT));
    let (mut socket, _) = tungstenite::client::connect_with_config(url, Some(config), 0).map_err(|e| format!("TikFinity isn't reachable ({e})"))?;
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = socket.get_ref() {
        s.set_read_timeout(Some(Duration::from_millis(500))).map_err(|e| e.to_string())?;
    }
    while !stop.load(Ordering::Relaxed) {
        match socket.read() {
            Ok(tungstenite::Message::Text(t)) => {
                if let Ok(Some(ev)) = parse(t.as_str()) {
                    on_event(ev);
                }
            }
            Ok(tungstenite::Message::Close(_)) => return Err("TikFinity closed the connection".into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let _ = socket.close(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    // Same shape as PearConnect's recorded fixture (test/fixtures/tikfinity-chat-nested.json).
    const NESTED: &str = r#"{"event":"chat","data":{"user":{"displayId":"fixture_viewer","idStr":"1234567890123456789","nickname":"A non-unique display name"},"common":{"msgId":"9876543210987654321"},"comment":"!sr Björk  \"Jóga\" 🦊"}}"#;

    #[test]
    fn chat_nested_and_flat() {
        let Some(TikTokEvent::Chat { msg_id, user, comment }) = parse(NESTED).unwrap() else {
            panic!()
        };
        assert_eq!(
            (msg_id.as_str(), user.id.as_str(), user.handle.as_str()),
            ("9876543210987654321", "1234567890123456789", "fixture_viewer")
        );
        assert_eq!(comment, "!sr Björk  \"Jóga\" 🦊", "text kept exactly");
        let flat = r#"{"event":"chat","data":{"uniqueId":"fan","userId":"42","msgId":"7","comment":"hi"}}"#;
        assert!(matches!(parse(flat).unwrap(), Some(TikTokEvent::Chat { .. })));
    }

    #[test]
    fn gifts_likes_social_viewers() {
        let gift = r#"{"event":"gift","data":{"uniqueId":"g","userId":"9","msgId":"1","giftId":5655,"giftName":"Rose","diamondCount":1,"repeatCount":5,"giftType":1,"repeatEnd":true}}"#;
        assert!(matches!(
            parse(gift).unwrap(),
            Some(TikTokEvent::Gift {
                diamonds: 1,
                repeat: 5,
                streak_end: true,
                ..
            })
        ));
        let streaking = gift.replace("\"repeatEnd\":true", "\"repeatEnd\":false");
        assert!(matches!(parse(&streaking).unwrap(), Some(TikTokEvent::Gift { streak_end: false, .. })));
        assert_eq!(
            parse(r#"{"event":"roomUser","data":{"viewerCount":812}}"#).unwrap(),
            Some(TikTokEvent::ViewerCount(812))
        );
        assert!(matches!(
            parse(r#"{"event":"follow","data":{"uniqueId":"f","userId":"3"}}"#).unwrap(),
            Some(TikTokEvent::Follow { .. })
        ));
        assert_eq!(parse(r#"{"event":"envelope","data":{}}"#).unwrap(), None);
    }

    #[test]
    fn hostile_events_are_refused() {
        assert!(parse(&"x".repeat(MAX_EVENT + 1)).is_err());
        assert!(parse("not json").is_err());
        assert!(
            parse(r#"{"event":"chat","data":{"uniqueId":"a","userId":"1","user":{"idStr":"2"},"comment":"x"}}"#).is_err(),
            "conflicting IDs"
        );
        assert!(parse(r#"{"event":"chat","data":{"uniqueId":"a","comment":"x"}}"#).is_err(), "no user ID");
        assert!(
            parse(r#"{"event":"chat","data":{"uniqueId":"a","userId":"12a","comment":"x"}}"#).is_err(),
            "non-numeric ID"
        );
        assert!(parse(r#"{"event":"chat","data":{"user":"nope","userId":"1"}}"#).is_err());
    }

    #[test]
    fn urls_are_loopback_only() {
        assert!(valid_url(DEFAULT_URL) && valid_url("ws://localhost:21213") && valid_url("ws://[::1]:21213/"));
        for bad in [
            "ws://192.168.1.5:21213/",
            "ws://127.0.0.1.evil.com:21213/",
            "http://127.0.0.1:21213/",
            "ws://user@127.0.0.1:21213/",
            "ws://127.0.0.1:21213/?x=1",
            "ws://127.0.0.1:0/",
            "ws://127.0.0.1/",
        ] {
            assert!(!valid_url(bad), "{bad}");
        }
    }
}
