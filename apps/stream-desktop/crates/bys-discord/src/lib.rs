//! Discord Rich Presence for BetterYTS Stream (Rust port and extension of PearConnect's
//! `desktop/discord-presence.js`).
//!
//! Talks only to the Discord app on this computer through its local IPC socket (named pipe on
//! Windows, Unix socket elsewhere). It needs no Discord login, OAuth secret, user token or bot,
//! and never reads messages or friends. Frames are size-capped; anything unexpected closes the
//! connection. Viewer names are shown only if the owner turns that on.

use serde_json::{Value, json};
use std::fmt;
use std::io::{Read, Write};

/// Public Discord application ID (shown as the app name in presence). Not a secret.
pub const CLIENT_ID: &str = "1545979656262389900";
pub const MAX_FRAME: usize = 64 * 1024;
/// Discord accepts one presence update per 15 seconds per client.
pub const MIN_INTERVAL_MS: u64 = 15_000;
/// Discord truncates `details` / `state` at 128 characters.
const MAX_TEXT: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscordError {
    NotRunning,
    Io(String),
    Protocol(&'static str),
    Rejected(String),
}

impl fmt::Display for DiscordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DiscordError::NotRunning => f.write_str("Discord isn't running"),
            DiscordError::Io(e) => write!(f, "Discord connection: {e}"),
            DiscordError::Protocol(e) => write!(f, "Discord sent something unexpected: {e}"),
            DiscordError::Rejected(e) => write!(f, "Discord refused the presence: {e}"),
        }
    }
}
impl std::error::Error for DiscordError {}

// ---- framing -------------------------------------------------------------------------------------

pub const OP_HANDSHAKE: u32 = 0;
pub const OP_FRAME: u32 = 1;
pub const OP_CLOSE: u32 = 2;
pub const OP_PING: u32 = 3;
pub const OP_PONG: u32 = 4;

pub fn encode(op: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

pub fn read_frame(r: &mut impl Read) -> Result<(u32, Vec<u8>), DiscordError> {
    let mut header = [0u8; 8];
    r.read_exact(&mut header).map_err(|e| DiscordError::Io(e.to_string()))?;
    let (op_bytes, len_bytes) = header.split_at(4);
    let op = u32::from_le_bytes(op_bytes.try_into().map_err(|_| DiscordError::Protocol("header"))?);
    let len = u32::from_le_bytes(len_bytes.try_into().map_err(|_| DiscordError::Protocol("header"))?) as usize;
    if len > MAX_FRAME {
        return Err(DiscordError::Protocol("frame too large"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(|e| DiscordError::Io(e.to_string()))?;
    Ok((op, body))
}

// ---- what to show --------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub requester: Option<String>,
    pub duration_s: Option<u32>,
    pub elapsed_s: Option<u32>,
    pub paused: bool,
    pub artwork: Option<String>,
}

/// Everything the app knows right now; [`activity`] decides what is shown.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PresenceInput {
    pub live: bool,
    /// Unix seconds when the session went live.
    pub live_since: Option<u64>,
    pub requests_open: bool,
    pub queue_length: u64,
    pub played: u64,
    /// Viewer / audience count per platform, e.g. [("TikTok", 812), ("Twitch", 120)].
    pub audience: Vec<(String, u64)>,
    pub track: Option<Track>,
    /// Latest trigger or alert, e.g. "Gift goal reached".
    pub last_trigger: Option<String>,
}

/// Owner toggles (mirrors `bys_store::DiscordSettings`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Show {
    pub now_playing: bool,
    pub audience: bool,
    pub requests: bool,
    pub triggers: bool,
    pub viewer_names: bool,
}

fn clean(s: &str) -> String {
    let c: String = s.chars().filter(|c| !c.is_control()).take(MAX_TEXT).collect();
    let t = c.trim();
    // Discord rejects strings shorter than 2 characters: pad with blank braille cells.
    if t.chars().count() < 2 {
        format!("{t}\u{2800}\u{2800}")
    } else {
        t.to_owned()
    }
}

fn compact(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => format!("{:.1}k", n as f64 / 1_000.0).replace(".0k", "k"),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0).replace(".0M", "M"),
    }
}

/// Build the activity, or `None` to clear presence (not live and nothing playing).
pub fn activity(input: &PresenceInput, show: Show, now_s: u64) -> Option<Value> {
    let playing = input.track.as_ref().filter(|_| show.now_playing);
    if !input.live && playing.is_none() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if show.audience {
        let total: u64 = input.audience.iter().map(|(_, n)| *n).sum();
        if total > 0 {
            parts.push(format!("{} watching", compact(total)));
        }
    }
    if show.requests {
        parts.push(if input.requests_open {
            format!("Requests open · {} in queue", input.queue_length)
        } else {
            "Requests paused".into()
        });
    }
    if show.triggers
        && let Some(t) = &input.last_trigger
    {
        parts.push(t.clone());
    }
    let summary = parts.join(" · ");
    let mut act = serde_json::Map::new();
    match playing {
        Some(track) => {
            act.insert("type".into(), json!(2)); // "Listening to"
            act.insert("details".into(), json!(clean(&track.title)));
            let by = match (&track.requester, show.viewer_names) {
                (Some(r), true) => format!("{} · requested by {r}", track.artist),
                _ => track.artist.clone(),
            };
            let state = if summary.is_empty() { by } else { format!("{by} · {summary}") };
            act.insert("state".into(), json!(clean(&state)));
            // Progress bar while playing; live timer otherwise.
            if let (Some(d), Some(e), false) = (track.duration_s, track.elapsed_s, track.paused) {
                let start = now_s.saturating_sub(u64::from(e));
                act.insert("timestamps".into(), json!({ "start": start, "end": start + u64::from(d) }));
            } else if let Some(since) = input.live_since {
                act.insert("timestamps".into(), json!({ "start": since }));
            }
            let mut assets = serde_json::Map::new();
            if let Some(art) = &track.artwork
                && art.starts_with("https://")
            {
                assets.insert("large_image".into(), json!(art));
                assets.insert("large_text".into(), json!(clean(&track.title)));
            }
            if input.live {
                assets.insert("small_text".into(), json!("Live on BetterYTS Stream"));
            }
            if !assets.is_empty() {
                act.insert("assets".into(), Value::Object(assets));
            }
        }
        None => {
            act.insert("type".into(), json!(0));
            act.insert("details".into(), json!("Live on stream"));
            act.insert("state".into(), json!(clean(if summary.is_empty() { "BetterYTS Stream" } else { &summary })));
            if let Some(since) = input.live_since {
                act.insert("timestamps".into(), json!({ "start": since }));
            }
        }
    }
    act.insert(
        "buttons".into(),
        json!([{ "label": "BetterYTS Stream", "url": "https://yts.foulfoxhacks.dev/stream" }]),
    );
    Some(Value::Object(act))
}

// ---- connection ----------------------------------------------------------------------------------

/// A connected, handshaken IPC session.
#[derive(Debug)]
pub struct Session<S: Read + Write> {
    stream: S,
    nonce: u64,
}

impl<S: Read + Write> Session<S> {
    /// Handshake and wait for Discord's READY.
    pub fn start(mut stream: S) -> Result<Self, DiscordError> {
        let hello = json!({ "v": 1, "client_id": CLIENT_ID }).to_string();
        stream
            .write_all(&encode(OP_HANDSHAKE, hello.as_bytes()))
            .map_err(|e| DiscordError::Io(e.to_string()))?;
        let mut s = Session { stream, nonce: 0 };
        let v = s.next_message()?;
        if v.get("evt").and_then(Value::as_str) == Some("READY") {
            Ok(s)
        } else {
            Err(DiscordError::Protocol("no READY after handshake"))
        }
    }

    /// Next JSON message, answering pings on the way.
    fn next_message(&mut self) -> Result<Value, DiscordError> {
        for _ in 0..16 {
            let (op, body) = read_frame(&mut self.stream)?;
            match op {
                OP_PING => self.stream.write_all(&encode(OP_PONG, &body)).map_err(|e| DiscordError::Io(e.to_string()))?,
                OP_PONG => {}
                OP_FRAME => return serde_json::from_slice(&body).map_err(|_| DiscordError::Protocol("invalid JSON")),
                OP_CLOSE => return Err(DiscordError::Io("Discord closed the connection".into())),
                _ => return Err(DiscordError::Protocol("unknown opcode")),
            }
        }
        Err(DiscordError::Protocol("too many control frames"))
    }

    /// Set (or clear with `None`) the activity and wait for Discord's answer.
    pub fn set_activity(&mut self, activity: Option<&Value>) -> Result<(), DiscordError> {
        self.nonce += 1;
        let nonce = format!("bys-{}-{}", std::process::id(), self.nonce);
        let frame = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce }).to_string();
        self.stream
            .write_all(&encode(OP_FRAME, frame.as_bytes()))
            .map_err(|e| DiscordError::Io(e.to_string()))?;
        for _ in 0..8 {
            let v = self.next_message()?;
            if v.get("nonce").and_then(Value::as_str) == Some(nonce.as_str()) {
                if v.get("evt").and_then(Value::as_str) == Some("ERROR") {
                    let msg = v.pointer("/data/message").and_then(Value::as_str).unwrap_or("unknown error");
                    return Err(DiscordError::Rejected(msg.chars().take(200).collect()));
                }
                return Ok(());
            }
        }
        Err(DiscordError::Protocol("no answer to SET_ACTIVITY"))
    }
}

/// Open the local Discord IPC socket (tries discord-ipc-0..9).
#[cfg(windows)]
pub fn connect() -> Result<Session<std::fs::File>, DiscordError> {
    for n in 0..10 {
        if let Ok(pipe) = std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{n}")) {
            return Session::start(pipe);
        }
    }
    Err(DiscordError::NotRunning)
}

#[cfg(unix)]
pub fn connect() -> Result<Session<std::os::unix::net::UnixStream>, DiscordError> {
    let base = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .unwrap_or_else(|| "/tmp".into());
    for dir in [base.clone(), format!("{base}/app/com.discordapp.Discord"), format!("{base}/snap.discord")] {
        for n in 0..10 {
            if let Ok(sock) = std::os::unix::net::UnixStream::connect(format!("{dir}/discord-ipc-{n}")) {
                let _ = sock.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                return Session::start(sock);
            }
        }
    }
    Err(DiscordError::NotRunning)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;
    use std::io::Cursor;

    const ALL: Show = Show {
        now_playing: true,
        audience: true,
        requests: true,
        triggers: true,
        viewer_names: false,
    };

    fn live() -> PresenceInput {
        PresenceInput {
            live: true,
            live_since: Some(1_000),
            requests_open: true,
            queue_length: 4,
            played: 10,
            audience: vec![("TikTok".into(), 1_200), ("Twitch".into(), 300)],
            track: Some(Track {
                title: "Song".into(),
                artist: "Band".into(),
                requester: Some("secretviewer".into()),
                duration_s: Some(200),
                elapsed_s: Some(50),
                paused: false,
                artwork: Some("https://i.ytimg.com/vi/x/hq.jpg".into()),
            }),
            last_trigger: Some("Gift goal reached".into()),
        }
    }

    #[test]
    fn listening_activity_with_progress_and_counts() {
        let a = activity(&live(), ALL, 10_000).unwrap();
        assert_eq!(a["type"], 2);
        assert_eq!(a["details"], "Song");
        assert_eq!(a["state"], "Band · 1.5k watching · Requests open · 4 in queue · Gift goal reached");
        assert_eq!(a["timestamps"], json!({ "start": 9_950, "end": 10_150 }));
        assert_eq!(a["assets"]["large_image"], "https://i.ytimg.com/vi/x/hq.jpg");
    }

    #[test]
    fn viewer_names_only_when_allowed_and_fields_toggle_off() {
        let hidden = activity(&live(), ALL, 0).unwrap().to_string();
        assert!(!hidden.contains("secretviewer"), "names hidden by default");
        let shown = activity(&live(), Show { viewer_names: true, ..ALL }, 0).unwrap();
        assert!(shown["state"].as_str().unwrap().contains("requested by secretviewer"));
        let quiet = activity(
            &live(),
            Show {
                audience: false,
                requests: false,
                triggers: false,
                ..ALL
            },
            0,
        )
        .unwrap();
        assert_eq!(quiet["state"], "Band");
    }

    #[test]
    fn live_without_music_and_cleared_when_idle() {
        let mut i = live();
        i.track = None;
        let a = activity(&i, ALL, 0).unwrap();
        assert_eq!((a["type"].as_i64(), a["details"].as_str()), (Some(0), Some("Live on stream")));
        assert_eq!(a["timestamps"]["start"], 1_000);
        assert!(activity(&PresenceInput::default(), ALL, 0).is_none(), "nothing to show clears presence");
        let mut long = live();
        long.track.as_mut().unwrap().title = "x\u{7}".repeat(300);
        assert!(activity(&long, ALL, 0).unwrap()["details"].as_str().unwrap().chars().count() <= MAX_TEXT);
    }

    /// In-memory Discord: replies are pre-scripted frames, writes are captured.
    struct Fake {
        input: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }
    impl Read for Fake {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Fake {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn frames(list: &[(u32, Value)]) -> Vec<u8> {
        list.iter().flat_map(|(op, v)| encode(*op, v.to_string().as_bytes())).collect()
    }

    #[test]
    fn handshake_ping_and_set_activity() {
        let nonce = format!("bys-{}-1", std::process::id());
        let script = frames(&[
            (OP_FRAME, json!({"evt": "READY"})),
            (OP_PING, json!({})),
            (OP_FRAME, json!({"cmd": "SET_ACTIVITY", "nonce": nonce})),
        ]);
        let mut s = Session::start(Fake {
            input: Cursor::new(script),
            written: vec![],
        })
        .unwrap();
        s.set_activity(activity(&live(), ALL, 0).as_ref()).unwrap();
        let w = &s.stream.written;
        assert_eq!(u32::from_le_bytes(w[0..4].try_into().unwrap()), OP_HANDSHAKE);
        assert!(String::from_utf8_lossy(w).contains(CLIENT_ID));
        assert!(w.windows(4).any(|x| x == OP_PONG.to_le_bytes()), "ping answered");
    }

    #[test]
    fn hostile_or_broken_frames_close_the_session() {
        let mut huge = encode(OP_FRAME, b"");
        huge[4..8].copy_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert_eq!(
            Session::start(Fake {
                input: Cursor::new(huge),
                written: vec![]
            })
            .err(),
            Some(DiscordError::Protocol("frame too large"))
        );
        let bad = encode(OP_FRAME, b"{not json");
        assert!(
            Session::start(Fake {
                input: Cursor::new(bad),
                written: vec![]
            })
            .is_err()
        );
        let nonce = format!("bys-{}-1", std::process::id());
        let rejected = frames(&[
            (OP_FRAME, json!({"evt": "READY"})),
            (OP_FRAME, json!({"evt": "ERROR", "nonce": nonce, "data": {"message": "bad activity"}})),
        ]);
        let mut s = Session::start(Fake {
            input: Cursor::new(rejected),
            written: vec![],
        })
        .unwrap();
        assert_eq!(s.set_activity(None), Err(DiscordError::Rejected("bad activity".into())));
    }

    #[test]
    fn compact_counts() {
        assert_eq!(
            (compact(999), compact(1_000), compact(1_250), compact(2_000_000)),
            ("999".into(), "1k".into(), "1.2k".into(), "2M".into())
        );
    }
}

/// Real Discord on this machine: handshake only (no activity is set, the profile doesn't change).
/// `cargo test -p bys-discord -- --ignored live`
#[cfg(test)]
mod live {
    #[test]
    #[ignore = "needs the Discord app running"]
    fn live_handshake_only() {
        assert!(super::connect().is_ok(), "Discord answered READY");
    }
}
