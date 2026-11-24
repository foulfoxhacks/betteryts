//! Twitch EventSub over WebSocket (official). Parses messages from `wss://eventsub.wss.twitch.tv`
//! and maps notifications to engine events.
//!
//! Defences: duplicate message IDs are ignored (Twitch may redeliver), messages older than
//! 10 minutes are refused (replay), and a `session_reconnect` URL is accepted only on Twitch's own
//! EventSub host, so a crafted message can't redirect the connection elsewhere.

use bys_core::event::{Event, EventKind, InvalidEvent, Platform, RawEvent, Role, Value as EvValue};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};

pub const EVENTSUB_URL: &str = "wss://eventsub.wss.twitch.tv/ws";
pub const MAX_MESSAGE: usize = 64 * 1024;
const REPLAY_WINDOW_S: i64 = 600;
const DEDUP: usize = 1000;

/// Subscriptions BetterYTS Stream creates, with the minimal scope each needs.
pub const SUBSCRIPTIONS: &[(&str, &str, &str)] = &[
    ("channel.follow", "2", "moderator:read:followers"),
    ("channel.subscribe", "1", "channel:read:subscriptions"),
    ("channel.subscription.gift", "1", "channel:read:subscriptions"),
    ("channel.subscription.message", "1", "channel:read:subscriptions"),
    ("channel.cheer", "1", "bits:read"),
    ("channel.raid", "1", "-"),
    ("channel.channel_points_custom_reward_redemption.add", "1", "channel:read:redemptions"),
];

#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Welcome {
        session_id: String,
        keepalive_s: u64,
    },
    Keepalive,
    Reconnect {
        url: String,
    },
    Revoked {
        subscription: String,
        reason: String,
    },
    Notification(Event),
    /// Duplicate, stale, unknown or unusable: nothing to do.
    Ignored(&'static str),
}

/// Remembers recent message IDs to drop redeliveries.
#[derive(Debug, Default)]
pub struct Dedup {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl Dedup {
    /// True the first time an ID is seen.
    pub fn first(&mut self, id: &str) -> bool {
        if self.seen.contains(id) {
            return false;
        }
        if self.order.len() >= DEDUP
            && let Some(old) = self.order.pop_front()
        {
            self.seen.remove(&old);
        }
        self.seen.insert(id.to_owned());
        self.order.push_back(id.to_owned());
        true
    }
}

/// Seconds since the Unix epoch from an RFC 3339 UTC timestamp like `2026-11-24T20:00:00.123Z`.
pub fn rfc3339_utc(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 20 || b.get(4) != Some(&b'-') || b.get(10) != Some(&b'T') || !ts.ends_with('Z') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| ts.get(r).and_then(|s| s.parse::<i64>().ok());
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + s)
}

fn s<'a>(v: &'a Value, path: &str) -> &'a str {
    v.pointer(path).and_then(Value::as_str).unwrap_or("")
}

fn amount(v: &Value, path: &str) -> f64 {
    v.pointer(path).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0).unwrap_or(0.0)
}

fn map(sub_type: &str, ev: &Value, msg_id: &str) -> Option<Result<Event, InvalidEvent>> {
    let (uid_path, name_path) = match sub_type {
        "channel.raid" => ("/from_broadcaster_user_id", "/from_broadcaster_user_name"),
        _ => ("/user_id", "/user_name"),
    };
    let uid = s(ev, uid_path);
    let actor = if uid.is_empty() { None } else { Some((uid, s(ev, name_path), Role::Viewer)) };
    let id = format!("twitch-es-{msg_id}");
    let (kind, text, amt, fields): (EventKind, &str, f64, Vec<(&str, EvValue)>) = match sub_type {
        "channel.follow" => (EventKind::Follow, "", 0.0, vec![]),
        "channel.subscribe" => (EventKind::Subscribe, "", 1.0, vec![("tier", EvValue::Text(s(ev, "/tier").into()))]),
        "channel.subscription.gift" => (EventKind::Subscribe, "", amount(ev, "/total").max(1.0), vec![("gift", EvValue::Bool(true))]),
        "channel.subscription.message" => (EventKind::Subscribe, s(ev, "/message/text"), amount(ev, "/cumulative_months").max(1.0), vec![]),
        "channel.cheer" => (EventKind::Cheer, s(ev, "/message"), amount(ev, "/bits"), vec![]),
        "channel.raid" => (EventKind::Raid, "", amount(ev, "/viewers"), vec![]),
        "channel.channel_points_custom_reward_redemption.add" => (
            EventKind::External,
            s(ev, "/user_input"),
            amount(ev, "/reward/cost"),
            vec![("reward", EvValue::Text(s(ev, "/reward/title").into()))],
        ),
        _ => return None,
    };
    let text: String = text.chars().take(1024).collect();
    Some(Event::new(
        Platform::Twitch,
        kind,
        RawEvent {
            id: &id,
            actor,
            text: &text,
            amount: amt,
            fields,
        },
    ))
}

/// Parse one EventSub WebSocket message. `now_s` is the current Unix time.
pub fn parse(raw: &str, dedup: &mut Dedup, now_s: i64) -> Result<Message, String> {
    if raw.len() > MAX_MESSAGE {
        return Err("EventSub message too large".into());
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| "EventSub message is not JSON".to_owned())?;
    let id = s(&v, "/metadata/message_id");
    let ts = rfc3339_utc(s(&v, "/metadata/message_timestamp")).ok_or("EventSub message has no valid timestamp")?;
    if (now_s - ts).abs() > REPLAY_WINDOW_S {
        return Ok(Message::Ignored("stale"));
    }
    if id.is_empty() || !dedup.first(id) {
        return Ok(Message::Ignored("duplicate"));
    }
    Ok(match s(&v, "/metadata/message_type") {
        "session_welcome" => Message::Welcome {
            session_id: s(&v, "/payload/session/id").chars().take(200).collect(),
            keepalive_s: v.pointer("/payload/session/keepalive_timeout_seconds").and_then(Value::as_u64).unwrap_or(10),
        },
        "session_keepalive" => Message::Keepalive,
        "session_reconnect" => {
            let url = s(&v, "/payload/session/reconnect_url");
            if url.starts_with("wss://eventsub.wss.twitch.tv/") && !url.contains('@') {
                Message::Reconnect { url: url.to_owned() }
            } else {
                Message::Ignored("reconnect to an unexpected host")
            }
        }
        "revocation" => Message::Revoked {
            subscription: s(&v, "/payload/subscription/type").into(),
            reason: s(&v, "/payload/subscription/status").into(),
        },
        "notification" => match map(s(&v, "/payload/subscription/type"), v.pointer("/payload/event").unwrap_or(&Value::Null), id) {
            Some(Ok(event)) => Message::Notification(event),
            Some(Err(_)) => Message::Ignored("invalid event"),
            None => Message::Ignored("unhandled subscription type"),
        },
        _ => Message::Ignored("unknown message type"),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic)]
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_795_548_000; // 2026-11-24T19:20:00Z
    fn msg(kind: &str, id: &str, ts: &str, payload: Value) -> String {
        json!({ "metadata": { "message_id": id, "message_type": kind, "message_timestamp": ts }, "payload": payload }).to_string()
    }
    fn note(sub: &str, id: &str, event: Value) -> String {
        msg(
            "notification",
            id,
            "2026-11-24T19:19:30.5Z",
            json!({ "subscription": { "type": sub }, "event": event }),
        )
    }

    #[test]
    fn timestamps() {
        assert_eq!(rfc3339_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_utc("2026-11-24T19:20:00.000Z"), Some(NOW));
        assert_eq!(rfc3339_utc("2026-11-24T19:20:00+02:00"), None, "UTC only");
        assert_eq!(rfc3339_utc("nonsense"), None);
    }

    #[test]
    fn welcome_and_notifications() {
        let mut d = Dedup::default();
        let w = parse(
            &msg(
                "session_welcome",
                "w1",
                "2026-11-24T19:19:59Z",
                json!({ "session": { "id": "S1", "keepalive_timeout_seconds": 30 } }),
            ),
            &mut d,
            NOW,
        )
        .unwrap();
        assert_eq!(
            w,
            Message::Welcome {
                session_id: "S1".into(),
                keepalive_s: 30
            }
        );
        let cheer = parse(
            &note(
                "channel.cheer",
                "n1",
                json!({ "user_id": "42", "user_name": "Giver", "bits": 500, "message": "Cheer500 love it" }),
            ),
            &mut d,
            NOW,
        )
        .unwrap();
        let Message::Notification(e) = cheer else { panic!("expected notification") };
        assert_eq!((e.kind, e.amount, e.text.as_str()), (EventKind::Cheer, 500.0, "Cheer500 love it"));
        let raid = parse(
            &note(
                "channel.raid",
                "n2",
                json!({ "from_broadcaster_user_id": "7", "from_broadcaster_user_name": "Raider", "viewers": 120 }),
            ),
            &mut d,
            NOW,
        )
        .unwrap();
        let Message::Notification(e) = raid else { panic!() };
        assert_eq!((e.kind, e.amount, e.actor.unwrap().id.as_str()), (EventKind::Raid, 120.0, "7"));
        let points = parse(
            &note(
                "channel.channel_points_custom_reward_redemption.add",
                "n3",
                json!({ "user_id": "9", "user_name": "F", "user_input": "play lofi", "reward": { "title": "Song request", "cost": 500 } }),
            ),
            &mut d,
            NOW,
        )
        .unwrap();
        let Message::Notification(e) = points else { panic!() };
        assert_eq!(e.fields.get("reward"), Some(&EvValue::Text("Song request".into())));
    }

    #[test]
    fn duplicates_stale_and_hijacks_are_refused() {
        let mut d = Dedup::default();
        let n = note("channel.follow", "dup", json!({ "user_id": "1", "user_name": "A" }));
        assert!(matches!(parse(&n, &mut d, NOW).unwrap(), Message::Notification(_)));
        assert_eq!(parse(&n, &mut d, NOW).unwrap(), Message::Ignored("duplicate"));
        assert_eq!(
            parse(&note("channel.follow", "old", json!({})), &mut d, NOW + 3600).unwrap(),
            Message::Ignored("stale")
        );
        let evil = msg(
            "session_reconnect",
            "r1",
            "2026-11-24T19:19:59Z",
            json!({ "session": { "reconnect_url": "wss://evil.example/ws" } }),
        );
        assert_eq!(parse(&evil, &mut d, NOW).unwrap(), Message::Ignored("reconnect to an unexpected host"));
        let good = msg(
            "session_reconnect",
            "r2",
            "2026-11-24T19:19:59Z",
            json!({ "session": { "reconnect_url": "wss://eventsub.wss.twitch.tv/ws?id=x" } }),
        );
        assert!(matches!(parse(&good, &mut d, NOW).unwrap(), Message::Reconnect { .. }));
        assert!(parse("not json", &mut d, NOW).is_err());
        assert!(parse(&"x".repeat(MAX_MESSAGE + 1), &mut d, NOW).is_err());
    }

    #[test]
    fn dedup_is_bounded() {
        let mut d = Dedup::default();
        for i in 0..DEDUP + 10 {
            assert!(d.first(&i.to_string()));
        }
        assert!(d.first("0"), "oldest IDs are forgotten");
        assert!(d.order.len() <= DEDUP);
    }
}
