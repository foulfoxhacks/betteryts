//! TikTok LIVE source for BetterYTS Stream (blueprint §4.1).
//!
//! **Unofficial protocol, read-only.** This crate decodes TikTok's webcast frames into
//! [`TikTokEvent`]s and maps them to normalized [`bys_core::event::Event`]s. It never posts,
//! never logs in and never handles the user's TikTok password or cookies.
//!
//! Field numbers follow the publicly documented webcast schema. They were cross-checked against
//! the TikTok-Webcast-Protobuf project for interoperability only; no code or schema text is copied.
//! The decoder is our own, bounded and fuzz-tested. TikTok can change this protocol at any time:
//! unknown message types are ignored, malformed frames are dropped, and the source fails closed.

pub mod proto;

use bys_core::event::{Event, EventKind, InvalidEvent, Platform, RawEvent, Role, Value as EvValue};
use proto::{ProtoError, Value, all, get, parse};
use std::io::Read;

/// Largest frame accepted from the socket, and largest it may decompress to.
pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_DECOMPRESSED: u64 = 4 * 1024 * 1024;
/// Messages decoded per frame at most (a frame normally carries a handful).
pub const MAX_MESSAGES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    /// Numeric TikTok user ID (stable; used for limits).
    pub id: String,
    /// @handle.
    pub handle: String,
    pub nickname: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TikTokEvent {
    Chat {
        msg_id: String,
        user: User,
        comment: String,
    },
    /// `streak_end` is false while a combo gift is still counting up; act on the final one only.
    Gift {
        msg_id: String,
        user: User,
        gift_id: u64,
        name: String,
        diamonds: u64,
        repeat: u64,
        streak_end: bool,
    },
    Like {
        msg_id: String,
        user: User,
        count: u64,
        total: u64,
    },
    Follow {
        msg_id: String,
        user: User,
    },
    Share {
        msg_id: String,
        user: User,
    },
    Join {
        msg_id: String,
        user: User,
    },
    ViewerCount(u64),
    StreamEnd,
}

/// One websocket frame after decoding.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Frame {
    /// Frame ID to acknowledge.
    pub ack_id: Option<u64>,
    pub events: Vec<TikTokEvent>,
    /// Message types we don't handle (for diagnostics only).
    pub ignored: usize,
}

fn user(bytes: Option<&[u8]>) -> Result<User, ProtoError> {
    let f = parse(bytes.ok_or(ProtoError("missing user"))?)?;
    let id = get(&f, 1).and_then(Value::as_u64).ok_or(ProtoError("user without id"))?;
    let text = |n| {
        get(&f, n)
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control())
            .take(100)
            .collect::<String>()
    };
    Ok(User {
        id: id.to_string(),
        handle: text(38),
        nickname: text(3),
    })
}

fn msg_id(f: &[(u32, Value<'_>)]) -> String {
    get(f, 1)
        .and_then(Value::as_bytes)
        .and_then(|e| parse(e).ok())
        .and_then(|e| get(&e, 2).and_then(Value::as_u64))
        .map(|n| n.to_string())
        .unwrap_or_default()
}

/// The event "display type" (distinguishes follow from share in social messages).
fn display_type(f: &[(u32, Value<'_>)]) -> String {
    get(f, 1)
        .and_then(Value::as_bytes)
        .and_then(|e| parse(e).ok())
        .and_then(|e| get(&e, 8).and_then(Value::as_bytes).and_then(|d| parse(d).ok()))
        .and_then(|d| get(&d, 1).and_then(Value::as_str).map(str::to_lowercase))
        .unwrap_or_default()
}

fn num(f: &[(u32, Value<'_>)], n: u32) -> u64 {
    get(f, n).and_then(Value::as_u64).unwrap_or(0)
}

/// Decode one inner webcast message by its type name. `Ok(None)` = a type we don't handle.
pub fn decode_message(kind: &str, data: &[u8]) -> Result<Option<TikTokEvent>, ProtoError> {
    let f = parse(data)?;
    Ok(Some(match kind {
        "WebcastChatMessage" => {
            let comment: String = get(&f, 3).and_then(Value::as_str).unwrap_or("").chars().take(1024).collect();
            TikTokEvent::Chat {
                msg_id: msg_id(&f),
                user: user(get(&f, 2).and_then(Value::as_bytes))?,
                comment,
            }
        }
        "WebcastGiftMessage" => {
            let details = get(&f, 15).and_then(Value::as_bytes).map(parse).transpose()?.unwrap_or_default();
            let gift_type = num(&details, 11);
            // Type 1 gifts can be sent as a streak (combo); repeatEnd marks the final message.
            let streak_end = gift_type != 1 || num(&f, 9) == 1;
            TikTokEvent::Gift {
                msg_id: msg_id(&f),
                user: user(get(&f, 7).and_then(Value::as_bytes))?,
                gift_id: num(&f, 2),
                name: get(&details, 16).and_then(Value::as_str).unwrap_or("").chars().take(100).collect(),
                diamonds: num(&details, 12),
                repeat: num(&f, 5).max(1),
                streak_end,
            }
        }
        "WebcastLikeMessage" => TikTokEvent::Like {
            msg_id: msg_id(&f),
            user: user(get(&f, 5).and_then(Value::as_bytes))?,
            count: num(&f, 2),
            total: num(&f, 3),
        },
        "WebcastSocialMessage" => {
            let dt = display_type(&f);
            let u = user(get(&f, 2).and_then(Value::as_bytes))?;
            if dt.contains("follow") {
                TikTokEvent::Follow { msg_id: msg_id(&f), user: u }
            } else if dt.contains("share") {
                TikTokEvent::Share { msg_id: msg_id(&f), user: u }
            } else {
                return Ok(None);
            }
        }
        "WebcastMemberMessage" => TikTokEvent::Join {
            msg_id: msg_id(&f),
            user: user(get(&f, 2).and_then(Value::as_bytes))?,
        },
        "WebcastRoomUserSeqMessage" => TikTokEvent::ViewerCount(num(&f, 3)),
        // ControlAction 3 = stream ended.
        "WebcastControlMessage" if num(&f, 2) == 3 => TikTokEvent::StreamEnd,
        _ => return Ok(None),
    }))
}

/// Decompress when the payload carries a gzip header; capped against decompression bombs.
fn maybe_gunzip(payload: &[u8]) -> Result<Vec<u8>, ProtoError> {
    if !payload.starts_with(&[0x1f, 0x8b]) {
        return Ok(payload.to_vec());
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(payload)
        .take(MAX_DECOMPRESSED + 1)
        .read_to_end(&mut out)
        .map_err(|_| ProtoError("bad gzip"))?;
    if out.len() as u64 > MAX_DECOMPRESSED {
        return Err(ProtoError("payload decompresses too large"));
    }
    Ok(out)
}

/// Decode a websocket push frame (`id` = 2, `type` = 7, payload = 8) and its batch of messages
/// (`messages` = 1, each `type` = 1 + `binary` = 2). Messages that fail to decode are skipped.
pub fn decode_frame(frame: &[u8]) -> Result<Frame, ProtoError> {
    if frame.len() > MAX_FRAME {
        return Err(ProtoError("frame too large"));
    }
    let f = parse(frame)?;
    let ack_id = get(&f, 2).and_then(Value::as_u64);
    if get(&f, 7).and_then(Value::as_str) != Some("msg") {
        return Ok(Frame { ack_id, ..Default::default() });
    }
    let payload = maybe_gunzip(get(&f, 8).and_then(Value::as_bytes).unwrap_or(&[]))?;
    let batch = parse(&payload)?;
    let mut out = Frame { ack_id, ..Default::default() };
    for m in all(&batch, 1).take(MAX_MESSAGES) {
        let Some(inner) = m.as_bytes().and_then(|b| parse(b).ok()) else {
            out.ignored += 1;
            continue;
        };
        let kind = get(&inner, 1).and_then(Value::as_str).unwrap_or("");
        let data = get(&inner, 2).and_then(Value::as_bytes).unwrap_or(&[]);
        match decode_message(kind, data) {
            Ok(Some(ev)) => out.events.push(ev),
            _ => out.ignored += 1,
        }
    }
    Ok(out)
}

/// Acknowledgement frame for `id` (sent back when TikTok asks for acks).
pub fn ack_frame(id: u64) -> Vec<u8> {
    let mut out = Vec::new();
    proto::put_uint(&mut out, 2, id);
    proto::put_bytes(&mut out, 7, b"ack");
    out
}

/// The actor tuple for [`RawEvent`]: numeric ID for limits, @handle (or nickname) for display.
fn actor(u: &User) -> Option<(&str, &str, Role)> {
    Some((
        u.id.as_str(),
        if u.handle.is_empty() { u.nickname.as_str() } else { u.handle.as_str() },
        Role::Viewer,
    ))
}

/// Map to a normalized engine event. Gift streaks map only on their final message;
/// joins and viewer counts are status, not triggers, so they map to `None`.
pub fn to_event(ev: &TikTokEvent) -> Option<Result<Event, InvalidEvent>> {
    let id = |prefix: &str, m: &str| format!("tiktok-{prefix}-{m}");
    Some(match ev {
        TikTokEvent::Chat { msg_id, user, comment } => Event::new(
            Platform::TikTok,
            EventKind::Chat,
            RawEvent {
                id: &id("chat", msg_id),
                actor: actor(user),
                text: comment,
                ..Default::default()
            },
        ),
        TikTokEvent::Gift {
            msg_id,
            user,
            gift_id,
            name,
            diamonds,
            repeat,
            streak_end,
        } => {
            if !streak_end {
                return None;
            }
            Event::new(
                Platform::TikTok,
                EventKind::Gift,
                RawEvent {
                    id: &id("gift", msg_id),
                    actor: actor(user),
                    text: "",
                    amount: (*diamonds as f64) * (*repeat as f64),
                    fields: vec![
                        ("gift", EvValue::Text(name.clone())),
                        ("gift_id", EvValue::Int(i64::try_from(*gift_id).unwrap_or(0))),
                        ("repeat", EvValue::Int(i64::try_from(*repeat).unwrap_or(0))),
                    ],
                },
            )
        }
        TikTokEvent::Like { msg_id, user, count, total } => Event::new(
            Platform::TikTok,
            EventKind::Like,
            RawEvent {
                id: &id("like", msg_id),
                actor: actor(user),
                amount: *count as f64,
                fields: vec![("total", EvValue::Int(i64::try_from(*total).unwrap_or(0)))],
                ..Default::default()
            },
        ),
        TikTokEvent::Follow { msg_id, user } => Event::new(
            Platform::TikTok,
            EventKind::Follow,
            RawEvent {
                id: &id("follow", msg_id),
                actor: actor(user),
                ..Default::default()
            },
        ),
        TikTokEvent::Share { msg_id, user } => Event::new(
            Platform::TikTok,
            EventKind::Share,
            RawEvent {
                id: &id("share", msg_id),
                actor: actor(user),
                ..Default::default()
            },
        ),
        TikTokEvent::Join { .. } | TikTokEvent::ViewerCount(_) | TikTokEvent::StreamEnd => return None,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::proto::{put_bytes, put_uint};
    use super::*;
    use std::io::Write;

    fn user_bytes(id: u64, handle: &str, nick: &str) -> Vec<u8> {
        let mut u = vec![];
        put_uint(&mut u, 1, id);
        put_bytes(&mut u, 3, nick.as_bytes());
        put_bytes(&mut u, 38, handle.as_bytes());
        u
    }
    fn event_bytes(msg_id: u64, display: &str) -> Vec<u8> {
        let mut details = vec![];
        put_bytes(&mut details, 1, display.as_bytes());
        let mut e = vec![];
        put_uint(&mut e, 2, msg_id);
        put_bytes(&mut e, 8, &details);
        e
    }
    fn wrap(kind: &str, data: &[u8]) -> Vec<u8> {
        let mut m = vec![];
        put_bytes(&mut m, 1, kind.as_bytes());
        put_bytes(&mut m, 2, data);
        m
    }
    fn frame(messages: &[Vec<u8>], gzip: bool) -> Vec<u8> {
        let mut batch = vec![];
        for m in messages {
            put_bytes(&mut batch, 1, m);
        }
        let payload = if gzip {
            let mut enc = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
            enc.write_all(&batch).unwrap();
            enc.finish().unwrap()
        } else {
            batch
        };
        let mut f = vec![];
        put_uint(&mut f, 2, 777);
        put_bytes(&mut f, 7, b"msg");
        put_bytes(&mut f, 8, &payload);
        f
    }

    fn chat() -> Vec<u8> {
        let mut c = vec![];
        put_bytes(&mut c, 1, &event_bytes(11, "chat"));
        put_bytes(&mut c, 2, &user_bytes(4242, "foxfan", "Fox Fan"));
        put_bytes(&mut c, 3, "!sr Daft Punk - One More Time".as_bytes());
        wrap("WebcastChatMessage", &c)
    }
    fn gift(repeat_end: u64, gift_type: u64) -> Vec<u8> {
        let mut d = vec![];
        put_uint(&mut d, 11, gift_type);
        put_uint(&mut d, 12, 5);
        put_bytes(&mut d, 16, b"Rose");
        let mut g = vec![];
        put_bytes(&mut g, 1, &event_bytes(22, "gift"));
        put_uint(&mut g, 2, 5655);
        put_uint(&mut g, 5, 3);
        put_bytes(&mut g, 7, &user_bytes(99, "giver", "Giver"));
        put_uint(&mut g, 9, repeat_end);
        put_bytes(&mut g, 15, &d);
        wrap("WebcastGiftMessage", &g)
    }
    fn social(display: &str) -> Vec<u8> {
        let mut s = vec![];
        put_bytes(&mut s, 1, &event_bytes(33, display));
        put_bytes(&mut s, 2, &user_bytes(7, "sharer", "S"));
        wrap("WebcastSocialMessage", &s)
    }

    #[test]
    fn decodes_a_gzipped_batch() {
        let mut viewers = vec![];
        put_uint(&mut viewers, 3, 812);
        let f = decode_frame(&frame(
            &[
                chat(),
                gift(1, 1),
                social("pm_main_follow_message_viewer_2"),
                social("pm_mt_guidance_share"),
                wrap("WebcastRoomUserSeqMessage", &viewers),
                wrap("WebcastSomethingNew", b""),
            ],
            true,
        ))
        .unwrap();
        assert_eq!(f.ack_id, Some(777));
        assert_eq!(f.ignored, 1, "unknown types are skipped");
        assert_eq!(
            f.events[0],
            TikTokEvent::Chat {
                msg_id: "11".into(),
                user: User {
                    id: "4242".into(),
                    handle: "foxfan".into(),
                    nickname: "Fox Fan".into()
                },
                comment: "!sr Daft Punk - One More Time".into()
            }
        );
        assert!(matches!(&f.events[1], TikTokEvent::Gift { name, diamonds: 5, repeat: 3, streak_end: true, .. } if name == "Rose"));
        assert!(matches!(f.events[2], TikTokEvent::Follow { .. }));
        assert!(matches!(f.events[3], TikTokEvent::Share { .. }));
        assert_eq!(f.events[4], TikTokEvent::ViewerCount(812));
    }

    #[test]
    fn engine_events_use_numeric_ids_and_final_gift_only() {
        let f = decode_frame(&frame(&[chat(), gift(0, 1), gift(1, 1)], false)).unwrap();
        let chat = to_event(&f.events[0]).unwrap().unwrap();
        assert_eq!((chat.kind, chat.text.as_str()), (EventKind::Chat, "!sr Daft Punk - One More Time"));
        let a = chat.actor.unwrap();
        assert_eq!(
            (a.id.as_str(), a.name.as_str()),
            ("4242", "foxfan"),
            "limits key on the numeric ID, display uses the handle"
        );
        assert!(to_event(&f.events[1]).is_none(), "streak still counting");
        let g = to_event(&f.events[2]).unwrap().unwrap();
        assert_eq!((g.kind, g.amount), (EventKind::Gift, 15.0), "5 diamonds x 3");
    }

    #[test]
    fn non_message_frames_and_acks() {
        let mut hb = vec![];
        put_uint(&mut hb, 2, 5);
        put_bytes(&mut hb, 7, b"hb");
        assert_eq!(
            decode_frame(&hb).unwrap(),
            Frame {
                ack_id: Some(5),
                ..Default::default()
            }
        );
        let ack = parse(&ack_frame(777))
            .unwrap()
            .into_iter()
            .map(|(f, v)| (f, v.as_u64(), v.as_str().map(str::to_owned)))
            .collect::<Vec<_>>();
        assert_eq!(ack, vec![(2, Some(777), None), (7, None, Some("ack".into()))]);
    }

    #[test]
    fn hostile_frames_fail_closed() {
        assert!(decode_frame(&vec![0u8; MAX_FRAME + 1]).is_err());
        // A gzip bomb: 10 MB of zeros compresses tiny but must not be expanded past the cap.
        let mut enc = flate2::write::GzEncoder::new(vec![], flate2::Compression::best());
        enc.write_all(&vec![0u8; 10 * 1024 * 1024]).unwrap();
        let bomb = enc.finish().unwrap();
        let mut f = vec![];
        put_bytes(&mut f, 7, b"msg");
        put_bytes(&mut f, 8, &bomb);
        assert_eq!(decode_frame(&f), Err(ProtoError("payload decompresses too large")));
        // A chat whose user has no ID is dropped, not mapped to an anonymous actor.
        let mut c = vec![];
        put_bytes(&mut c, 2, b"");
        put_bytes(&mut c, 3, b"hi");
        assert_eq!(decode_frame(&frame(&[wrap("WebcastChatMessage", &c)], false)).unwrap().ignored, 1);
    }

    #[test]
    fn random_frames_never_panic() {
        let mut x: u64 = 0x0123_4567_89ab_cdef;
        for len in 0..1500usize {
            let buf: Vec<u8> = (0..len % 257)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    (x & 0xff) as u8
                })
                .collect();
            let _ = decode_frame(&buf);
            for kind in ["WebcastChatMessage", "WebcastGiftMessage", "WebcastLikeMessage", "WebcastSocialMessage"] {
                let _ = decode_message(kind, &buf);
            }
        }
    }
}
