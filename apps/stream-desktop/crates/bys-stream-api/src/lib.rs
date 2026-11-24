//! Typed client for the BetterYTS Stream API (`/api/stream/v1`, served by the BetterYTS Worker,
//! `src/stream/routes.ts`). The HTTP layer is the [`Transport`] trait: [`HttpTransport`] (ureq +
//! rustls) in the app, a fake in tests.
//!
//! Security: HTTPS only (plain HTTP only for loopback during development), no redirects, bounded
//! response size, a request timeout, and credentials that never print (`Debug` is redacted).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fmt;

pub const DEFAULT_ORIGIN: &str = "https://yts.foulfoxhacks.dev";
/// Largest response body read from the API.
pub const MAX_RESPONSE: usize = 1024 * 1024;

/// A 64-hex-character session credential (owner or scoped). Never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential(String);

impl Credential {
    pub fn new(value: &str) -> Result<Self, ApiError> {
        let v = value.trim();
        if v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            Ok(Credential(v.to_owned()))
        } else {
            Err(ApiError::Invalid("a credential is 64 lowercase hex characters".into()))
        }
    }
    /// For storing in the OS keychain only.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credential(<redacted>)")
    }
}

impl<'de> Deserialize<'de> for Credential {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Credential::new(&s).map_err(serde::de::Error::custom)
    }
}

/// A session code like `ABCD2345` (no 0/O/1/I).
pub fn valid_code(code: &str) -> bool {
    code.len() == 8 && code.bytes().all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&b))
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// The server answered with `{ok:false, code, message}`.
    Server { status: u16, code: String, message: String },
    /// Network, TLS or timeout failure. The outcome of a write may be unknown.
    Transport(String),
    /// The response was not the JSON we expected.
    BadResponse(String),
    /// Refused locally before sending.
    Invalid(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Server { message, code, .. } => write!(f, "{message} ({code})"),
            ApiError::Transport(e) => write!(f, "couldn't reach BetterYTS Stream: {e}"),
            ApiError::BadResponse(e) => write!(f, "unexpected response from BetterYTS Stream: {e}"),
            ApiError::Invalid(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for ApiError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

/// One HTTP exchange. Implementations must not follow redirects and must cap the body at [`MAX_RESPONSE`].
pub trait Transport {
    fn send(&self, method: Method, url: &str, bearer: Option<&str>, body: Option<&str>) -> Result<(u16, String), ApiError>;
}

// ---- response types ----------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicView {
    pub code: String,
    pub expires_at: u64,
    pub ended: bool,
    pub accepting: bool,
    pub destination_online: bool,
    pub destination_ready: bool,
    pub approval_mode: String,
    pub command: String,
    pub max_song_seconds: u64,
    pub revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreated {
    #[serde(flatten)]
    pub view: PublicView,
    pub owner_token: Credential,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub title: String,
    pub creator: String,
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub state: String,
    pub code: Option<String>,
    pub message: String,
    pub media: Option<Media>,
    pub ahead: Option<u64>,
    #[serde(default)]
    pub outcome_uncertain: bool,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub requester: String,
    #[serde(default)]
    pub input: String,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub updated: u64,
    #[serde(default)]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct Stats {
    pub received: u64,
    pub accepted: u64,
    pub rejected: u64,
    pub completed: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    #[serde(flatten)]
    pub view: PublicView,
    pub intake: bool,
    pub policy: Value,
    #[serde(default)]
    pub stats: Stats,
    pub active: Vec<Entry>,
    pub history: Vec<Entry>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Claimed {
    pub id: String,
    pub requester: String,
    pub platform: String,
    pub input: String,
    pub media: Media,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ClaimResult {
    #[serde(flatten)]
    pub view: PublicView,
    pub request: Option<Claimed>,
}

#[derive(Debug, Deserialize)]
pub struct MintedToken {
    pub id: String,
    pub scope: String,
    pub expires: u64,
    pub token: Credential,
    #[serde(rename = "overlayUrl")]
    pub overlay_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Moderator,
    Intake,
    Destination,
    Overlay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Approve,
    Reject,
    Remove,
    Complete,
    Skip,
    Reorder,
    Clear,
}

/// Fields for `POST /manage`; `None` leaves a setting unchanged.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Manage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intake: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<bool>,
}

/// A playback destination's result for one claimed request.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub id: String,
    pub outcome: Outcome,
    /// Short machine code, e.g. `added`, `outcome_uncertain`, `destination_failed`.
    pub code: String,
    pub message: String,
    /// The write may have happened even though it wasn't confirmed: never retry it.
    pub uncertain: bool,
}

/// What a playback destination reports after handling a claimed request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Playing,
    Completed,
    Failed,
}

fn with(mut body: Value, key: &str, value: Value) -> Value {
    if let Some(obj) = body.as_object_mut() {
        obj.insert(key.to_owned(), value);
    }
    body
}

// ---- client ------------------------------------------------------------------------------------

#[derive(Debug)]
pub struct Client<T: Transport> {
    base: String,
    transport: T,
}

fn origin_ok(origin: &str) -> bool {
    let lower = origin.to_ascii_lowercase();
    let host_part = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")).unwrap_or("");
    let host = host_part.split(['/', ':']).next().unwrap_or("");
    let no_path = !host_part.contains('/') && !host_part.contains('@') && !host_part.contains('?') && !host_part.contains('#');
    no_path && !host.is_empty() && (lower.starts_with("https://") || matches!(host, "127.0.0.1" | "localhost"))
}

impl<T: Transport> Client<T> {
    /// `origin` like `https://yts.foulfoxhacks.dev` (HTTPS required except for loopback).
    pub fn new(origin: &str, transport: T) -> Result<Self, ApiError> {
        let origin = origin.trim_end_matches('/');
        if !origin_ok(origin) {
            return Err(ApiError::Invalid("the BetterYTS address must be an https:// origin".into()));
        }
        Ok(Client {
            base: format!("{origin}/api/stream/v1"),
            transport,
        })
    }

    fn call<R: for<'de> Deserialize<'de>>(&self, method: Method, path: &str, bearer: Option<&Credential>, body: Option<Value>) -> Result<R, ApiError> {
        let text = body.map(|b| b.to_string());
        let (status, raw) = self
            .transport
            .send(method, &format!("{}{}", self.base, path), bearer.map(Credential::expose), text.as_deref())?;
        if raw.len() > MAX_RESPONSE {
            return Err(ApiError::BadResponse("response too large".into()));
        }
        let value: Value = serde_json::from_str(&raw).map_err(|_| ApiError::BadResponse(format!("HTTP {status}, not JSON")))?;
        // Rejected requests come back as receipts (ok:false + state); only bare failures are errors.
        if value.get("ok") == Some(&Value::Bool(false)) && value.get("state").is_none() {
            let s = |k: &str| value.get(k).and_then(Value::as_str).unwrap_or("").chars().take(1200).collect::<String>();
            return Err(ApiError::Server {
                status,
                code: s("code"),
                message: s("message"),
            });
        }
        serde_json::from_value(value).map_err(|e| ApiError::BadResponse(e.to_string()))
    }

    fn session(code: &str) -> Result<String, ApiError> {
        if valid_code(code) {
            Ok(format!("/sessions/{code}"))
        } else {
            Err(ApiError::Invalid("session codes are 8 characters (A-Z, 2-9, no O/I)".into()))
        }
    }

    pub fn create_session(&self, minutes: u32, policy: Option<Value>) -> Result<SessionCreated, ApiError> {
        if !(15..=1440).contains(&minutes) {
            return Err(ApiError::Invalid("choose 15 to 1440 minutes".into()));
        }
        let mut body = json!({ "minutes": minutes });
        if let Some(p) = policy {
            body = with(body, "policy", p);
        }
        self.call(Method::Post, "/sessions", None, Some(body))
    }

    pub fn public_view(&self, code: &str) -> Result<PublicView, ApiError> {
        self.call(Method::Get, &Self::session(code)?, None, None)
    }

    pub fn queue(&self, code: &str, cred: &Credential) -> Result<QueueState, ApiError> {
        self.call(Method::Get, &format!("{}/queue", Self::session(code)?), Some(cred), None)
    }

    pub fn moderate(
        &self,
        code: &str,
        cred: &Credential,
        action: Action,
        id: Option<&str>,
        position: Option<u32>,
        reason: Option<&str>,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "action": action });
        if let Some(id) = id {
            body = with(body, "id", json!(id));
        }
        if let Some(p) = position {
            body = with(body, "position", json!(p));
        }
        if let Some(r) = reason {
            body = with(body, "reason", json!(r.chars().take(300).collect::<String>()));
        }
        self.call(Method::Post, &format!("{}/queue/action", Self::session(code)?), Some(cred), Some(body))
    }

    pub fn manage(&self, code: &str, cred: &Credential, update: &Manage) -> Result<Value, ApiError> {
        let body = serde_json::to_value(update).map_err(|e| ApiError::Invalid(e.to_string()))?;
        self.call(Method::Post, &format!("{}/manage", Self::session(code)?), Some(cred), Some(body))
    }

    pub fn mint_token(&self, code: &str, owner: &Credential, scope: Scope, minutes: u32, label: &str) -> Result<MintedToken, ApiError> {
        let body = json!({ "scope": scope, "minutes": minutes, "label": label.chars().take(60).collect::<String>() });
        self.call(Method::Post, &format!("{}/tokens", Self::session(code)?), Some(owner), Some(body))
    }

    pub fn revoke_token(&self, code: &str, owner: &Credential, id: &str) -> Result<Value, ApiError> {
        self.call(
            Method::Post,
            &format!("{}/tokens/revoke", Self::session(code)?),
            Some(owner),
            Some(json!({ "id": id })),
        )
    }

    /// Heartbeat + claim of the next queued request for this playback destination.
    pub fn claim(&self, code: &str, cred: &Credential, ready: bool) -> Result<ClaimResult, ApiError> {
        self.call(
            Method::Post,
            &format!("{}/destination/claim", Self::session(code)?),
            Some(cred),
            Some(json!({ "ready": ready })),
        )
    }

    pub fn report(&self, code: &str, cred: &Credential, report: &Report) -> Result<Value, ApiError> {
        let body = json!({
            "id": report.id,
            "state": report.outcome,
            "code": report.code,
            "message": report.message.chars().take(1200).collect::<String>(),
            "outcomeUncertain": report.uncertain,
        });
        self.call(Method::Post, &format!("{}/destination/report", Self::session(code)?), Some(cred), Some(body))
    }
}

// ---- real transport ----------------------------------------------------------------------------

/// HTTPS transport: rustls, no redirects, 15 s timeout, body capped at [`MAX_RESPONSE`].
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
            .timeout_global(Some(std::time::Duration::from_secs(15)))
            .user_agent(concat!("BetterYTS-Stream-Desktop/", env!("CARGO_PKG_VERSION")))
            .build();
        HttpTransport {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

#[cfg(feature = "http")]
impl Transport for HttpTransport {
    fn send(&self, method: Method, url: &str, bearer: Option<&str>, body: Option<&str>) -> Result<(u16, String), ApiError> {
        let auth = bearer.map(|b| format!("Bearer {b}"));
        let result = match (method, body) {
            (Method::Get, _) => {
                let mut r = self.agent.get(url);
                if let Some(a) = &auth {
                    r = r.header("Authorization", a);
                }
                r.call()
            }
            (Method::Post, body) => {
                let mut r = self.agent.post(url).header("Content-Type", "application/json");
                if let Some(a) = &auth {
                    r = r.header("Authorization", a);
                }
                r.send(body.unwrap_or("{}"))
            }
        };
        let mut response = result.map_err(|e| ApiError::Transport(e.to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE as u64)
            .read_to_string()
            .map_err(|e| ApiError::Transport(e.to_string()))?;
        Ok((status, text))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::type_complexity)]
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        replies: RefCell<Vec<(u16, String)>>,
        sent: RefCell<Vec<(Method, String, Option<String>, Option<String>)>>,
    }
    impl Transport for &Fake {
        fn send(&self, m: Method, url: &str, bearer: Option<&str>, body: Option<&str>) -> Result<(u16, String), ApiError> {
            self.sent
                .borrow_mut()
                .push((m, url.to_owned(), bearer.map(str::to_owned), body.map(str::to_owned)));
            Ok(self.replies.borrow_mut().remove(0))
        }
    }
    const VIEW: &str = r#""code":"ABCD2345","expiresAt":1,"ended":false,"accepting":true,"destinationOnline":false,"destinationReady":false,"approvalMode":"auto","command":"!sr","maxSongSeconds":420,"revision":3"#;
    fn tok(c: char) -> String {
        std::iter::repeat_n(c, 64).collect()
    }

    #[test]
    fn origins_and_codes_are_checked_before_sending() {
        let f = Fake::default();
        assert!(Client::new("http://evil.example", &f).is_err(), "plain HTTP refused");
        assert!(Client::new("https://yts.foulfoxhacks.dev/path", &f).is_err());
        assert!(Client::new("https://user@yts.foulfoxhacks.dev", &f).is_err());
        assert!(Client::new("http://127.0.0.1:8787", &f).is_ok(), "loopback dev allowed");
        let c = Client::new(DEFAULT_ORIGIN, &f).unwrap();
        assert!(matches!(c.public_view("abcd2345"), Err(ApiError::Invalid(_))));
        assert!(matches!(c.public_view("ABCD234O"), Err(ApiError::Invalid(_))));
        assert!(c.create_session(5, None).is_err());
        assert!(f.sent.borrow().is_empty(), "nothing was sent");
    }

    #[test]
    fn create_session_parses_and_hides_the_credential() {
        let f = Fake::default();
        f.replies
            .borrow_mut()
            .push((201, format!(r#"{{"ok":true,{VIEW},"ownerToken":"{}"}}"#, tok('a'))));
        let c = Client::new(DEFAULT_ORIGIN, &f).unwrap();
        let s = c.create_session(60, Some(json!({"cooldownSeconds": 0}))).unwrap();
        assert_eq!(s.view.code, "ABCD2345");
        assert_eq!(s.owner_token.expose(), tok('a'));
        assert!(!format!("{s:?}").contains(&tok('a')), "Debug never prints the credential");
        let sent = &f.sent.borrow()[0];
        assert_eq!(sent.1, "https://yts.foulfoxhacks.dev/api/stream/v1/sessions");
        assert!(sent.2.is_none(), "creation sends no credential");
        assert!(sent.3.as_deref().unwrap().contains("\"cooldownSeconds\":0"));
    }

    #[test]
    fn queue_with_stats_and_moderation() {
        let f = Fake::default();
        let entry = r#"{"ok":true,"id":"r1","state":"queued","code":"accepted","message":"added","media":{"id":"dQw4w9WgXcQ","title":"Song","creator":"Artist","durationSeconds":212},"ahead":0,"outcomeUncertain":false,"platform":"twitch","requester":"fox","input":"song","created":1,"updated":2,"position":1}"#;
        f.replies.borrow_mut().push((200, format!(r#"{{"ok":true,{VIEW},"intake":true,"policy":{{}},"stats":{{"received":5,"accepted":3,"rejected":1,"completed":2}},"active":[{entry}],"history":[],"audit":[],"tokens":[]}}"#)));
        f.replies
            .borrow_mut()
            .push((200, r#"{"ok":true,"request":{"ok":true,"id":"r1","state":"completed"}}"#.into()));
        let c = Client::new(DEFAULT_ORIGIN, &f).unwrap();
        let cred = Credential::new(&tok('b')).unwrap();
        let q = c.queue("ABCD2345", &cred).unwrap();
        assert_eq!(
            q.stats,
            Stats {
                received: 5,
                accepted: 3,
                rejected: 1,
                completed: 2
            }
        );
        assert_eq!(q.active[0].media.as_ref().unwrap().title, "Song");
        c.moderate("ABCD2345", &cred, Action::Complete, Some("r1"), None, None).unwrap();
        let sent = f.sent.borrow();
        assert_eq!(sent[0].2.as_deref(), Some(tok('b').as_str()));
        assert_eq!(sent[1].1, "https://yts.foulfoxhacks.dev/api/stream/v1/sessions/ABCD2345/queue/action");
        assert_eq!(sent[1].3.as_deref(), Some(r#"{"action":"complete","id":"r1"}"#));
    }

    #[test]
    fn server_errors_and_bad_responses() {
        let f = Fake::default();
        f.replies.borrow_mut().push((
            401,
            r#"{"ok":false,"code":"unauthorized","message":"A valid session credential is required."}"#.into(),
        ));
        f.replies.borrow_mut().push((502, "<html>bad gateway</html>".into()));
        f.replies
            .borrow_mut()
            .push((200, format!(r#"{{"ok":true,{VIEW},"ownerToken":"not-a-token"}}"#)));
        let c = Client::new(DEFAULT_ORIGIN, &f).unwrap();
        let cred = Credential::new(&tok('c')).unwrap();
        assert!(matches!(c.queue("ABCD2345", &cred), Err(ApiError::Server { status: 401, ref code, .. }) if code == "unauthorized"));
        assert!(matches!(c.public_view("ABCD2345"), Err(ApiError::BadResponse(_))));
        assert!(
            matches!(c.create_session(60, None), Err(ApiError::BadResponse(_))),
            "malformed credential in a response is refused"
        );
    }

    #[test]
    fn destination_claim_and_report() {
        let f = Fake::default();
        f.replies.borrow_mut().push((200, format!(r#"{{"ok":true,{VIEW},"intake":true,"request":{{"id":"r9","requester":"fox","platform":"tiktok","input":"x","media":{{"id":"dQw4w9WgXcQ","title":"T","creator":"C","durationSeconds":null,"thumbnail":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"}}}}}}"#)));
        f.replies.borrow_mut().push((200, r#"{"ok":true,"request":{}}"#.into()));
        let c = Client::new(DEFAULT_ORIGIN, &f).unwrap();
        let cred = Credential::new(&tok('d')).unwrap();
        let claim = c.claim("ABCD2345", &cred, true).unwrap();
        assert_eq!(claim.request.unwrap().media.id, "dQw4w9WgXcQ");
        c.report(
            "ABCD2345",
            &cred,
            &Report {
                id: "r9".into(),
                outcome: Outcome::Completed,
                code: "added".into(),
                message: "Added at position 4".into(),
                uncertain: false,
            },
        )
        .unwrap();
        assert!(f.sent.borrow()[1].3.as_deref().unwrap().contains(r#""state":"completed""#));
    }

    #[test]
    fn credentials_are_validated() {
        assert!(Credential::new("short").is_err());
        assert!(Credential::new(&tok('A')).is_err(), "uppercase is not what the server issues");
        assert!(Credential::new(&tok('g')).is_err(), "not hex");
        assert!(Credential::new(&tok('f')).is_ok());
    }
}

/// Live round trip against production: `cargo test -p bys-stream-api -- --ignored live`.
#[cfg(all(test, feature = "http"))]
mod live {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    #[test]
    #[ignore = "network: creates and ends a real 15-minute session"]
    fn live_create_queue_end() {
        let c = Client::new(DEFAULT_ORIGIN, HttpTransport::default()).unwrap();
        let s = c.create_session(15, None).unwrap();
        let q = c.queue(&s.view.code, &s.owner_token).unwrap();
        assert!(!q.intake && q.active.is_empty());
        let wrong = Credential::new(&"0".repeat(64)).unwrap();
        assert!(matches!(c.queue(&s.view.code, &wrong), Err(ApiError::Server { status: 401, .. })));
        let ended = c
            .manage(
                &s.view.code,
                &s.owner_token,
                &Manage {
                    end: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(ended.get("ended"), Some(&Value::Bool(true)));
    }
}
