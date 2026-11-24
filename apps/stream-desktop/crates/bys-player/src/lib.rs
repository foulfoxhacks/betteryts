//! Pear Desktop playback destination (Rust port of PearConnect's `src/ytmd.js`,
//! `src/player-queue.js` and the `dispatch()` rules from `src/betteryts-stream.js`).
//!
//! Pear Desktop's API Server plugin listens on this machine only. Rules carried over from PearConnect:
//! - The host must be loopback (`127.0.0.1`, `localhost`, `[::1]`). Credentials never leave the machine.
//! - Pear's `204` on "add to queue" means "command dispatched", not "added". The add is confirmed
//!   by diffing the queue before and after.
//! - A write is never retried: if confirmation fails, the outcome is reported as uncertain.
//! - Remote bodies and tokens are never echoed into errors or logs.

use serde::Deserialize;
use serde_json::{Value, json};
use std::fmt;
use std::time::Duration;

pub const MAX_RESPONSE: usize = 4 * 1024 * 1024;
pub const MAX_QUEUE: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PearError {
    /// Not a loopback HTTP origin.
    BadHost,
    Unauthorized,
    Http(u16),
    Unreachable(String),
    BadResponse(&'static str),
}

impl fmt::Display for PearError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PearError::BadHost => f.write_str("Pear Desktop's address must be on this computer (http://127.0.0.1:port)"),
            PearError::Unauthorized => f.write_str("Pear Desktop refused the request; authorize BetterYTS Stream in Pear Desktop again"),
            PearError::Http(s) => write!(f, "Pear Desktop answered HTTP {s}; check its API Server plugin"),
            PearError::Unreachable(e) => write!(f, "Pear Desktop isn't reachable ({e})"),
            PearError::BadResponse(e) => write!(f, "Pear Desktop returned an unexpected response: {e}"),
        }
    }
}
impl std::error::Error for PearError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

/// One HTTP exchange with Pear Desktop. `Ok((status, body))`; body is `None` for 204.
pub trait Transport {
    fn send(&self, method: Method, url: &str, bearer: Option<&str>, body: Option<&str>) -> Result<(u16, Option<String>), PearError>;
}

/// Loopback-only origin check (same rule as PearConnect's `apiHost` plus a loopback requirement).
pub fn loopback_origin(host: &str) -> Result<String, PearError> {
    let h = host.trim().trim_end_matches('/');
    let rest = h.strip_prefix("http://").ok_or(PearError::BadHost)?;
    if rest.contains(['/', '@', '?', '#']) {
        return Err(PearError::BadHost);
    }
    let name = if rest.starts_with("[::1]") {
        "[::1]"
    } else {
        rest.split(':').next().unwrap_or("")
    };
    let port_ok = match rest.strip_prefix(name) {
        Some("") => true,
        Some(p) => p.strip_prefix(':').is_some_and(|p| p.parse::<u16>().is_ok_and(|n| n > 0)),
        None => false,
    };
    if matches!(name, "127.0.0.1" | "localhost" | "[::1]") && port_ok {
        Ok(h.to_owned())
    } else {
        Err(PearError::BadHost)
    }
}

/// One row of Pear's ordered queue. Position is a snapshot, never ownership.
#[derive(Debug, Clone, PartialEq)]
pub struct QueueRow {
    pub video_id: String,
    pub position: usize,
    pub title: String,
    pub artist: String,
    pub selected: bool,
}

/// What's playing, cleaned for display (Discord presence, overlays).
#[derive(Debug, Clone, PartialEq)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub video_id: Option<String>,
    pub duration_s: Option<u32>,
    pub elapsed_s: Option<u32>,
    pub paused: Option<bool>,
    pub artwork: Option<String>,
}

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Object(o) => {
            if let Some(Value::String(s)) = o.get("simpleText") {
                s.trim().to_owned()
            } else if let Some(Value::Array(runs)) = o.get("runs") {
                runs.iter()
                    .filter_map(|r| r.get("text").and_then(Value::as_str))
                    .collect::<String>()
                    .trim()
                    .to_owned()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

fn clip(s: String, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

fn video_id_ok(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Port of `playerQueue`: only the ordered queue, never nested menus or recommendations.
pub fn parse_queue(data: Option<&Value>) -> Result<Vec<QueueRow>, PearError> {
    let Some(data) = data else { return Ok(vec![]) };
    if data.is_null() {
        return Ok(vec![]);
    }
    let items = data
        .get("items")
        .and_then(Value::as_array)
        .ok_or(PearError::BadResponse("queue has no items"))?;
    if items.len() > MAX_QUEUE {
        return Err(PearError::BadResponse("queue is unexpectedly large"));
    }
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let row = item
                .get("playlistPanelVideoRenderer")
                .or_else(|| item.pointer("/playlistPanelVideoWrapperRenderer/primaryRenderer/playlistPanelVideoRenderer"))
                .ok_or(PearError::BadResponse("unrecognized queue item"))?;
            let id = row
                .get("videoId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(PearError::BadResponse("queue item without a video"))?;
            Ok(QueueRow {
                video_id: id.to_owned(),
                position: i + 1,
                title: clip(row.get("title").map(text).unwrap_or_default(), 512),
                artist: clip(row.get("shortBylineText").map(text).unwrap_or_default(), 512),
                selected: row.get("selected") == Some(&Value::Bool(true)),
            })
        })
        .collect()
}

/// Port of `findQueueAddition`: a new copy of `video_id` appeared (handles repeats of the same song).
pub fn find_addition<'a>(before: &[QueueRow], after: &'a [QueueRow], video_id: &str) -> Option<&'a QueueRow> {
    let previous = before.iter().filter(|r| r.video_id == video_id).count();
    let matches: Vec<&QueueRow> = after.iter().filter(|r| r.video_id == video_id).collect();
    if matches.len() > previous { matches.last().copied() } else { None }
}

/// Port of `normalizePlayback` + `artworkUrl`: public fields only, artwork from known image hosts.
pub fn parse_now_playing(raw: Option<&Value>) -> Option<NowPlaying> {
    let raw = raw?;
    let title = clip(raw.get("title").and_then(Value::as_str).unwrap_or("").to_owned(), 300);
    if title.is_empty() {
        return None;
    }
    let secs = |k: &str| {
        raw.get(k)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 604_800.0)
            .map(|v| v as u32)
    };
    let duration = secs("songDuration").filter(|d| *d > 0);
    let artwork = raw.get("imageSrc").and_then(Value::as_str).filter(|u| {
        ["https://i.ytimg.com/", "https://lh3.googleusercontent.com/", "https://yt3.ggpht.com/"]
            .iter()
            .any(|p| u.starts_with(p))
            && !u.contains(['@', ' '])
    });
    Some(NowPlaying {
        title,
        artist: clip(raw.get("artist").and_then(Value::as_str).unwrap_or("").to_owned(), 300),
        video_id: raw.get("videoId").and_then(Value::as_str).filter(|v| video_id_ok(v)).map(str::to_owned),
        duration_s: duration,
        elapsed_s: secs("elapsedSeconds").map(|e| duration.map_or(e, |d| e.min(d))),
        paused: raw.get("isPaused").and_then(Value::as_bool),
        artwork: artwork.map(str::to_owned),
    })
}

/// Pear Desktop API client. The token is the Pear "API Server" access token (never printed).
pub struct Pear<T: Transport> {
    origin: String,
    token: Option<String>,
    transport: T,
}

impl<T: Transport> fmt::Debug for Pear<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pear")
            .field("origin", &self.origin)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

const API: &str = "/api/v1";

impl<T: Transport> Pear<T> {
    pub fn new(host: &str, token: Option<String>, transport: T) -> Result<Self, PearError> {
        Ok(Pear {
            origin: loopback_origin(host)?,
            token,
            transport,
        })
    }

    fn req(&self, method: Method, path: &str, body: Option<Value>) -> Result<Option<Value>, PearError> {
        let text = body.map(|b| b.to_string());
        let (status, raw) = self
            .transport
            .send(method, &format!("{}{}", self.origin, path), self.token.as_deref(), text.as_deref())?;
        match status {
            401 | 403 => return Err(PearError::Unauthorized),
            204 => return Ok(None),
            200..=299 => {}
            s => return Err(PearError::Http(s)),
        }
        let Some(raw) = raw else { return Ok(None) };
        if raw.len() > MAX_RESPONSE {
            return Err(PearError::BadResponse("response too large"));
        }
        serde_json::from_str(&raw).map(Some).map_err(|_| PearError::BadResponse("not JSON"))
    }

    /// One-time authorization: the user approves "BetterYTS Stream" inside Pear Desktop.
    pub fn request_token(&self, client_id: &str) -> Result<String, PearError> {
        if client_id.is_empty() || client_id.len() > 100 || !client_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(PearError::BadResponse("client id must be letters, digits, '-' or '_'"));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Auth {
            access_token: String,
        }
        let v = self
            .req(Method::Post, &format!("/auth/{client_id}"), None)?
            .ok_or(PearError::BadResponse("empty authorization response"))?;
        let auth: Auth = serde_json::from_value(v).map_err(|_| PearError::BadResponse("authorization response has no token"))?;
        if auth.access_token.is_empty() {
            Err(PearError::BadResponse("empty token"))
        } else {
            Ok(auth.access_token)
        }
    }

    pub fn queue(&self) -> Result<Vec<QueueRow>, PearError> {
        parse_queue(self.req(Method::Get, &format!("{API}/queue"), None)?.as_ref())
    }

    pub fn add_to_queue(&self, video_id: &str) -> Result<(), PearError> {
        if !video_id_ok(video_id) {
            return Err(PearError::BadResponse("not a YouTube video id"));
        }
        self.req(
            Method::Post,
            &format!("{API}/queue"),
            Some(json!({ "videoId": video_id, "insertPosition": "INSERT_AT_END" })),
        )
        .map(|_| ())
    }

    pub fn now_playing(&self) -> Result<Option<NowPlaying>, PearError> {
        Ok(parse_now_playing(self.req(Method::Get, &format!("{API}/song"), None)?.as_ref()))
    }

    pub fn next(&self) -> Result<(), PearError> {
        self.req(Method::Post, &format!("{API}/next"), None).map(|_| ())
    }
}

/// Result of handing one claimed request to Pear Desktop, ready for the Stream `report` call.
#[derive(Debug, Clone, PartialEq)]
pub struct Dispatch {
    pub completed: bool,
    pub code: &'static str,
    pub message: String,
    /// The write may have happened: never send it again.
    pub uncertain: bool,
}

/// Add `video_id` and confirm it by queue diff (PearConnect rules). `wait` sleeps between reads.
pub fn dispatch<T: Transport>(pear: &Pear<T>, video_id: &str, mut wait: impl FnMut(Duration)) -> Dispatch {
    let fail = |code, message: &str, uncertain| Dispatch {
        completed: false,
        code,
        message: message.to_owned(),
        uncertain,
    };
    if !video_id_ok(video_id) {
        return fail("destination_failed", "The request had no playable video.", false);
    }
    let before = match pear.queue() {
        Ok(q) => q,
        Err(_) => return fail("destination_failed", "Pear Desktop's queue couldn't be read. Nothing was sent.", false),
    };
    if pear.add_to_queue(video_id).is_err() {
        return fail(
            "outcome_uncertain",
            "Pear Desktop didn't confirm the add. Check the end of its queue before retrying.",
            true,
        );
    }
    for attempt in 0..5u32 {
        if attempt > 0 {
            wait(Duration::from_millis(500 * u64::from(attempt)));
        }
        match pear.queue() {
            Ok(after) => {
                if let Some(row) = find_addition(&before, &after, video_id) {
                    return Dispatch {
                        completed: true,
                        code: "added",
                        message: format!("Added to Pear Desktop at queue position {}.", row.position),
                        uncertain: false,
                    };
                }
            }
            Err(_) => break,
        }
    }
    fail(
        "outcome_uncertain",
        "Pear Desktop accepted the command but its queue didn't show a new entry. Check the end of the queue.",
        true,
    )
}

/// Real transport: plain HTTP to loopback (Pear has no TLS), no redirects, 10 s timeout, size cap.
#[cfg(feature = "http")]
#[derive(Debug)]
pub struct HttpTransport {
    agent: ureq::Agent,
}

#[cfg(feature = "http")]
impl Default for HttpTransport {
    fn default() -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(10)))
            .build();
        HttpTransport {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

#[cfg(feature = "http")]
impl Transport for HttpTransport {
    fn send(&self, method: Method, url: &str, bearer: Option<&str>, body: Option<&str>) -> Result<(u16, Option<String>), PearError> {
        let auth = bearer.map(|b| format!("Bearer {b}"));
        let result = match method {
            Method::Get => {
                let mut r = self.agent.get(url).header("Accept", "application/json");
                if let Some(a) = &auth {
                    r = r.header("Authorization", a);
                }
                r.call()
            }
            Method::Post => {
                let mut r = self.agent.post(url).header("Accept", "application/json");
                if let Some(a) = &auth {
                    r = r.header("Authorization", a);
                }
                match body {
                    Some(b) => r.header("Content-Type", "application/json").send(b),
                    None => r.send_empty(),
                }
            }
        };
        let mut response = result.map_err(|e| PearError::Unreachable(e.to_string()))?;
        let status = response.status().as_u16();
        if status == 204 {
            return Ok((status, None));
        }
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE as u64)
            .read_to_string()
            .map_err(|e| PearError::Unreachable(e.to_string()))?;
        Ok((status, Some(text)))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;
    use std::cell::RefCell;

    /// Simulates Pear: a queue that `add` appends to (unless `ignore_adds`), with call log.
    #[derive(Default)]
    struct FakePear {
        queue: RefCell<Vec<String>>,
        ignore_adds: bool,
        fail_add: bool,
        calls: RefCell<Vec<String>>,
    }
    impl Transport for &FakePear {
        fn send(&self, m: Method, url: &str, bearer: Option<&str>, body: Option<&str>) -> Result<(u16, Option<String>), PearError> {
            assert_eq!(bearer, Some("tok"));
            let path = url.trim_start_matches("http://127.0.0.1:26538");
            self.calls.borrow_mut().push(format!("{m:?} {path}"));
            match (m, path) {
                (Method::Get, "/api/v1/queue") => {
                    let items: Vec<Value> = self
                        .queue
                        .borrow()
                        .iter()
                        .map(|id| json!({"playlistPanelVideoRenderer": {"videoId": id, "title": {"runs": [{"text": "T"}]}}}))
                        .collect();
                    Ok((200, Some(json!({ "items": items }).to_string())))
                }
                (Method::Post, "/api/v1/queue") => {
                    if self.fail_add {
                        return Err(PearError::Unreachable("timeout".into()));
                    }
                    let v: Value = serde_json::from_str(body.unwrap()).unwrap();
                    if !self.ignore_adds {
                        self.queue.borrow_mut().push(v["videoId"].as_str().unwrap().to_owned());
                    }
                    Ok((204, None))
                }
                _ => Ok((404, None)),
            }
        }
    }
    fn pear(f: &FakePear) -> Pear<&FakePear> {
        Pear::new("http://127.0.0.1:26538", Some("tok".into()), f).unwrap()
    }

    #[test]
    fn host_must_be_loopback() {
        for ok in ["http://127.0.0.1:26538", "http://localhost:26538/", "http://[::1]:26538"] {
            assert!(loopback_origin(ok).is_ok(), "{ok}");
        }
        for bad in [
            "https://127.0.0.1:26538",
            "http://192.168.1.5:26538",
            "http://127.0.0.1.evil.com",
            "http://user@127.0.0.1",
            "http://127.0.0.1:26538/api",
            "http://127.0.0.1:0",
            "http://127.0.0.1:99999",
        ] {
            assert!(loopback_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn verified_add_reports_position() {
        let f = FakePear {
            queue: RefCell::new(vec!["aaaaaaaaaaa".into(), "dQw4w9WgXcQ".into()]),
            ..Default::default()
        };
        let d = dispatch(&pear(&f), "dQw4w9WgXcQ", |_| {});
        assert!(d.completed && !d.uncertain);
        assert_eq!(
            d.message, "Added to Pear Desktop at queue position 3.",
            "a repeat of an existing song counts as new"
        );
        assert_eq!(f.calls.borrow().iter().filter(|c| c.starts_with("Post")).count(), 1);
    }

    #[test]
    fn unconfirmed_or_failed_writes_are_uncertain_and_never_retried() {
        let ignored = FakePear {
            ignore_adds: true,
            ..Default::default()
        };
        let mut waits = vec![];
        let d = dispatch(&pear(&ignored), "dQw4w9WgXcQ", |w| waits.push(w));
        assert!(!d.completed && d.uncertain);
        assert_eq!(ignored.calls.borrow().iter().filter(|c| c.starts_with("Post")).count(), 1, "one write only");
        assert_eq!(waits.len(), 4, "backs off between reads");
        let failing = FakePear {
            fail_add: true,
            ..Default::default()
        };
        let d = dispatch(&pear(&failing), "dQw4w9WgXcQ", |_| {});
        assert!(d.uncertain && d.code == "outcome_uncertain");
        assert!(
            !dispatch(&pear(&FakePear::default()), "bad id", |_| {}).uncertain,
            "invalid id: nothing was sent"
        );
    }

    #[test]
    fn queue_parsing_is_strict() {
        let wrapped = json!({"items": [{"playlistPanelVideoWrapperRenderer": {"primaryRenderer": {"playlistPanelVideoRenderer": {"videoId": "x", "selected": true, "shortBylineText": {"simpleText": " Art "}}}}}]});
        let rows = parse_queue(Some(&wrapped)).unwrap();
        assert_eq!((rows[0].position, rows[0].selected, rows[0].artist.as_str()), (1, true, "Art"));
        assert!(parse_queue(Some(&json!({"items": [{"other": {}}]}))).is_err());
        assert!(parse_queue(Some(&json!({"nope": 1}))).is_err());
        assert!(parse_queue(None).unwrap().is_empty());
    }

    #[test]
    fn now_playing_keeps_public_fields_only() {
        let raw = json!({"title": "Song\u{7}", "artist": "Band", "videoId": "dQw4w9WgXcQ", "songDuration": 200, "elapsedSeconds": 999, "isPaused": false, "imageSrc": "https://lh3.googleusercontent.com/a.jpg", "secretThing": "x"});
        let n = parse_now_playing(Some(&raw)).unwrap();
        assert_eq!((n.title.as_str(), n.elapsed_s, n.duration_s), ("Song", Some(200), Some(200)));
        assert_eq!(n.artwork.as_deref(), Some("https://lh3.googleusercontent.com/a.jpg"));
        let evil = json!({"title": "x", "imageSrc": "https://evil.example/a.jpg", "videoId": "../../etc"});
        let n = parse_now_playing(Some(&evil)).unwrap();
        assert!(n.artwork.is_none() && n.video_id.is_none());
        assert!(parse_now_playing(Some(&json!({"title": ""}))).is_none());
    }

    #[test]
    fn token_is_redacted_and_auth_errors_are_mapped() {
        let f = FakePear::default();
        assert!(!format!("{:?}", pear(&f)).contains("tok\""));
        struct Denied;
        impl Transport for Denied {
            fn send(&self, _: Method, _: &str, _: Option<&str>, _: Option<&str>) -> Result<(u16, Option<String>), PearError> {
                Ok((403, Some("<html>secret page</html>".into())))
            }
        }
        let p = Pear::new("http://127.0.0.1:26538", None, Denied).unwrap();
        assert_eq!(p.queue(), Err(PearError::Unauthorized));
        assert!(!PearError::Unauthorized.to_string().contains("secret"));
    }
}
