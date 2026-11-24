//! Normalized events. Every source adapter (TikTok, Twitch, OSC, local API, ...) converts what it
//! receives into an [`Event`] through [`Event::new`], which enforces the size and content limits, so
//! the rest of the engine never sees raw platform data.

use std::collections::BTreeMap;
use std::fmt;

/// Where an event came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Platform {
    TikTok,
    Twitch,
    YouTube,
    Kick,
    Web,
    Android,
    VrChat,
    /// The streamer's own machine: hotkeys, buttons, timers, the local API.
    Local,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::TikTok => "tiktok",
            Platform::Twitch => "twitch",
            Platform::YouTube => "youtube",
            Platform::Kick => "kick",
            Platform::Web => "web",
            Platform::Android => "android",
            Platform::VrChat => "vrchat",
            Platform::Local => "local",
        }
    }
}

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EventKind {
    Chat,
    Gift,
    Like,
    Follow,
    Share,
    Subscribe,
    Cheer,
    Raid,
    SongRequest,
    ShoutoutRequest,
    OscInput,
    Timer,
    Manual,
    External,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Chat => "chat",
            EventKind::Gift => "gift",
            EventKind::Like => "like",
            EventKind::Follow => "follow",
            EventKind::Share => "share",
            EventKind::Subscribe => "subscribe",
            EventKind::Cheer => "cheer",
            EventKind::Raid => "raid",
            EventKind::SongRequest => "song_request",
            EventKind::ShoutoutRequest => "shoutout_request",
            EventKind::OscInput => "osc_input",
            EventKind::Timer => "timer",
            EventKind::Manual => "manual",
            EventKind::External => "external",
        }
    }
}

/// The requester's standing on the platform, as reported by the source adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    Viewer,
    Subscriber,
    Moderator,
    Owner,
}

/// A typed value carried by events, conditions and outputs.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl Value {
    /// Numeric view used by comparisons; text and booleans are not numbers.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Int(i) => Some(*i as f64),
            Value::Float(f) if f.is_finite() => Some(*f),
            _ => None,
        }
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Bool(b) => write!(f, "{b}"),
            Value::Int(i) => write!(f, "{i}"),
            Value::Float(x) => write!(f, "{x}"),
            Value::Text(s) => f.write_str(s),
        }
    }
}

/// Who caused the event. `id` is the platform's stable user ID (never a display name), so limits
/// can't be dodged by renaming.
#[derive(Debug, Clone, PartialEq)]
pub struct Actor {
    pub id: String,
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub id: String,
    pub platform: Platform,
    pub kind: EventKind,
    pub actor: Option<Actor>,
    /// Chat text, request input or shoutout message.
    pub text: String,
    /// Gift value, bits, like count, OSC level, ... (0 when not applicable).
    pub amount: f64,
    /// Extra adapter-specific fields (gift name, OSC address, ...).
    pub fields: BTreeMap<String, Value>,
}

pub const MAX_ID: usize = 128;
pub const MAX_NAME: usize = 100;
pub const MAX_TEXT: usize = 1024;
pub const MAX_FIELDS: usize = 32;
pub const MAX_FIELD_KEY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidEvent(pub String);

impl fmt::Display for InvalidEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid event: {}", self.0)
    }
}
impl std::error::Error for InvalidEvent {}

fn bad(msg: impl Into<String>) -> InvalidEvent {
    InvalidEvent(msg.into())
}

/// Length-limited text with no control characters (newlines in chat are folded to spaces).
fn clean(value: &str, name: &str, max: usize) -> Result<String, InvalidEvent> {
    let folded: String = value.chars().map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c }).collect();
    let trimmed = folded.trim();
    if trimmed.chars().count() > max {
        return Err(bad(format!("{name} is longer than {max} characters")));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(bad(format!("{name} contains control characters")));
    }
    Ok(trimmed.to_owned())
}

/// Builder input for [`Event::new`].
#[derive(Debug, Clone, Default)]
pub struct RawEvent<'a> {
    pub id: &'a str,
    pub actor: Option<(&'a str, &'a str, Role)>,
    pub text: &'a str,
    pub amount: f64,
    pub fields: Vec<(&'a str, Value)>,
}

impl Event {
    /// The only way to build an event: validates everything an adapter hands over.
    pub fn new(platform: Platform, kind: EventKind, raw: RawEvent<'_>) -> Result<Event, InvalidEvent> {
        let id = clean(raw.id, "id", MAX_ID)?;
        if id.is_empty() {
            return Err(bad("id is required"));
        }
        let actor = match raw.actor {
            None => None,
            Some((aid, name, role)) => {
                let aid = clean(aid, "actor id", MAX_ID)?;
                if aid.is_empty() {
                    return Err(bad("actor id is required when an actor is given"));
                }
                let name = clean(name.trim_start_matches('@'), "actor name", MAX_NAME)?;
                Some(Actor { id: aid, name, role })
            }
        };
        if !raw.amount.is_finite() || raw.amount < 0.0 {
            return Err(bad("amount must be a finite, non-negative number"));
        }
        if raw.fields.len() > MAX_FIELDS {
            return Err(bad(format!("at most {MAX_FIELDS} fields")));
        }
        let mut fields = BTreeMap::new();
        for (key, value) in raw.fields {
            if key.is_empty() || key.len() > MAX_FIELD_KEY || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.') {
                return Err(bad("field names are 1-64 ASCII letters, digits, '_' or '.'"));
            }
            let value = match value {
                Value::Text(s) => Value::Text(clean(&s, key, MAX_TEXT)?),
                Value::Float(f) if !f.is_finite() => return Err(bad(format!("field {key} is not finite"))),
                other => other,
            };
            fields.insert(key.to_owned(), value);
        }
        Ok(Event {
            id,
            platform,
            kind,
            actor,
            text: clean(raw.text, "text", MAX_TEXT)?,
            amount: raw.amount,
            fields,
        })
    }

    /// True when the streamer's own machine caused this event (hotkey, button, timer, local API).
    pub fn is_owner_origin(&self) -> bool {
        self.platform == Platform::Local || self.actor.as_ref().is_some_and(|a| a.role == Role::Owner)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn valid_event_is_normalized() {
        let e = Event::new(
            Platform::TikTok,
            EventKind::Chat,
            RawEvent {
                id: "m1",
                actor: Some(("123", "@viewer", Role::Viewer)),
                text: " hi\nthere ",
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(e.text, "hi there");
        assert_eq!(e.actor.unwrap().name, "viewer");
    }

    #[test]
    fn hostile_input_is_rejected() {
        let long = "x".repeat(MAX_TEXT + 1);
        assert!(
            Event::new(
                Platform::Twitch,
                EventKind::Chat,
                RawEvent {
                    id: "m",
                    text: &long,
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            Event::new(
                Platform::Twitch,
                EventKind::Chat,
                RawEvent {
                    id: "m",
                    text: "a\u{7}b",
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            Event::new(
                Platform::Twitch,
                EventKind::Gift,
                RawEvent {
                    id: "m",
                    amount: f64::NAN,
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            Event::new(
                Platform::Twitch,
                EventKind::Gift,
                RawEvent {
                    id: "m",
                    amount: -1.0,
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(Event::new(Platform::Twitch, EventKind::Gift, RawEvent { id: "", ..Default::default() }).is_err());
        assert!(
            Event::new(
                Platform::Twitch,
                EventKind::Gift,
                RawEvent {
                    id: "m",
                    fields: vec![("bad key!", Value::Int(1))],
                    ..Default::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn owner_origin() {
        let local = Event::new(
            Platform::Local,
            EventKind::Manual,
            RawEvent {
                id: "b1",
                ..Default::default()
            },
        )
        .unwrap();
        assert!(local.is_owner_origin());
        let viewer = Event::new(
            Platform::TikTok,
            EventKind::Gift,
            RawEvent {
                id: "g",
                actor: Some(("1", "v", Role::Viewer)),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!viewer.is_owner_origin());
    }
}
