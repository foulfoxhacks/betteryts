//! Live Twitch connection (feature `net`): OAuth device flow over HTTPS, EventSub and IRC chat over
//! WebSocket (TLS via rustls). Everything here talks only to Twitch's own hosts.

use crate::eventsub::{self, Dedup, EVENTSUB_URL, Message, SUBSCRIPTIONS};
use crate::{irc, oauth};
use bys_core::event::Event;
use serde_json::{Value, json};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message as WsMessage, WebSocket};

/// Public client ID of the "BetterYTS Connector" Twitch application (public client, no secret).
pub const CLIENT_ID: &str = "5ddaqfcv7ehy3gwuw7va5tadgh5d99";
pub const IRC_URL: &str = "wss://irc-ws.chat.twitch.tv:443";
const HELIX: &str = "https://api.twitch.tv/helix";
const MAX_BODY: u64 = 256 * 1024;

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(15)))
            .build(),
    )
}

fn post_form(url: &str, body: &str) -> Result<(u16, String), String> {
    let mut r = agent()
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(body)
        .map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    Ok((status, r.body_mut().with_config().limit(MAX_BODY).read_to_string().map_err(|e| e.to_string())?))
}

/// Step 1: ask Twitch for a code the user enters at twitch.tv/activate.
pub fn device_start(chat_replies: bool) -> Result<oauth::DeviceCode, String> {
    let (_, body) = post_form(oauth::DEVICE_URL, &oauth::device_request(CLIENT_ID, chat_replies)?)?;
    oauth::parse_device(&body)
}

/// Step 2: poll until the user approves (call every `interval` seconds).
pub fn device_poll(device_code: &str, chat_replies: bool) -> oauth::Poll {
    match post_form(oauth::TOKEN_URL, &oauth::token_request(CLIENT_ID, device_code, chat_replies)) {
        Ok((status, body)) => oauth::parse_poll(status, &body),
        Err(e) => oauth::Poll::Failed(e),
    }
}

/// Exchange a refresh token (public clients need no secret; Twitch rotates the refresh token).
pub fn refresh(refresh_token: &str) -> oauth::Poll {
    let body = format!(
        "client_id={CLIENT_ID}&grant_type=refresh_token&refresh_token={}",
        refresh_token
            .bytes()
            .map(|b| if b.is_ascii_alphanumeric() {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            })
            .collect::<String>()
    );
    match post_form(oauth::TOKEN_URL, &body) {
        Ok((status, body)) => oauth::parse_poll(status, &body),
        Err(e) => oauth::Poll::Failed(e),
    }
}

/// Who the token belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub user_id: String,
    pub login: String,
    pub expires_in: u64,
}

pub fn validate(access_token: &str) -> Result<Identity, String> {
    let mut r = agent()
        .get(oauth::VALIDATE_URL)
        .header("Authorization", &format!("OAuth {access_token}"))
        .call()
        .map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let body = r.body_mut().with_config().limit(MAX_BODY).read_to_string().map_err(|e| e.to_string())?;
    if status == 401 {
        return Err("Twitch sign-in expired".into());
    }
    let v: Value = serde_json::from_str(&body).map_err(|_| "unexpected validate response".to_owned())?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    if v.get("client_id").and_then(Value::as_str) != Some(CLIENT_ID) {
        return Err("this token belongs to a different Twitch application".into());
    }
    let id = s("user_id");
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Twitch didn't return a user ID".into());
    }
    Ok(Identity {
        user_id: id,
        login: s("login").to_ascii_lowercase(),
        expires_in: v.get("expires_in").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// `viewer_count` from a Helix `streams` response: `Some(n)` while live, `None` when offline.
pub fn parse_viewers(body: &str) -> Result<Option<u64>, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "unexpected streams response".to_owned())?;
    let data = v.get("data").and_then(Value::as_array).ok_or("unexpected streams response")?;
    Ok(data.first().and_then(|s| s.get("viewer_count")).and_then(Value::as_u64))
}

/// Current viewer count of a channel (Helix, read-only, needs no extra scope).
pub fn viewers(access_token: &str, user_id: &str) -> Result<Option<u64>, String> {
    if user_id.is_empty() || !user_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid user ID".into());
    }
    let mut r = agent()
        .get(&format!("{HELIX}/streams?user_id={user_id}"))
        .header("Authorization", &format!("Bearer {access_token}"))
        .header("Client-Id", CLIENT_ID)
        .call()
        .map_err(|e| e.to_string())?;
    if r.status().as_u16() != 200 {
        return Err(format!("Twitch answered HTTP {}", r.status().as_u16()));
    }
    parse_viewers(&r.body_mut().with_config().limit(MAX_BODY).read_to_string().map_err(|e| e.to_string())?)
}

/// Post a chat message as the signed-in user (needs the `user:write:chat` scope). Text is cleaned
/// and capped at Twitch's 500 characters.
pub fn send_chat(access_token: &str, broadcaster: &str, sender: &str, message: &str) -> Result<(), String> {
    let text: String = message.chars().filter(|c| !c.is_control()).take(500).collect();
    if text.trim().is_empty() {
        return Ok(());
    }
    let body = json!({ "broadcaster_id": broadcaster, "sender_id": sender, "message": text }).to_string();
    let r = agent()
        .post(&format!("{HELIX}/chat/messages"))
        .header("Authorization", &format!("Bearer {access_token}"))
        .header("Client-Id", CLIENT_ID)
        .header("Content-Type", "application/json")
        .send(body.as_str())
        .map_err(|e| e.to_string())?;
    match r.status().as_u16() {
        200 => Ok(()),
        401 | 403 => Err("Twitch didn't allow the reply: connect Twitch again with replies on".into()),
        s => Err(format!("Twitch answered HTTP {s}")),
    }
}

/// Condition for each subscription type (raids are "to" the broadcaster; follows need a moderator ID).
pub fn condition(sub_type: &str, broadcaster: &str) -> Value {
    match sub_type {
        "channel.follow" => json!({ "broadcaster_user_id": broadcaster, "moderator_user_id": broadcaster }),
        "channel.raid" => json!({ "to_broadcaster_user_id": broadcaster }),
        _ => json!({ "broadcaster_user_id": broadcaster }),
    }
}

/// Create the EventSub subscriptions for a session. Returns the types that failed (with status).
pub fn subscribe(access_token: &str, session_id: &str, broadcaster: &str) -> Vec<(String, String)> {
    let mut failed = Vec::new();
    for (kind, version, _) in SUBSCRIPTIONS {
        let body = json!({ "type": kind, "version": version, "condition": condition(kind, broadcaster), "transport": { "method": "websocket", "session_id": session_id } }).to_string();
        let res = agent()
            .post(&format!("{HELIX}/eventsub/subscriptions"))
            .header("Authorization", &format!("Bearer {access_token}"))
            .header("Client-Id", CLIENT_ID)
            .header("Content-Type", "application/json")
            .send(body.as_str());
        match res {
            Ok(r) if r.status().as_u16() == 202 => {}
            Ok(r) => failed.push((kind.to_string(), format!("HTTP {}", r.status().as_u16()))),
            Err(e) => failed.push((kind.to_string(), e.to_string())),
        }
    }
    failed
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn connect(url: &str, max_message: usize) -> Result<Socket, String> {
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(max_message))
        .max_frame_size(Some(max_message));
    let (socket, _) = tungstenite::client::connect_with_config(url, Some(config), 3).map_err(|e| e.to_string())?;
    // Short read timeouts so the loops can notice the stop flag.
    let timeout = Some(Duration::from_millis(500));
    match socket.get_ref() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(timeout).map_err(|e| e.to_string())?,
        MaybeTlsStream::Rustls(s) => s.get_ref().set_read_timeout(timeout).map_err(|e| e.to_string())?,
        _ => {}
    }
    Ok(socket)
}

enum Read {
    Text(String),
    Idle,
    Closed,
}

fn read(socket: &mut Socket) -> Result<Read, String> {
    match socket.read() {
        Ok(WsMessage::Text(t)) => Ok(Read::Text(t.to_string())),
        Ok(WsMessage::Close(_)) => Ok(Read::Closed),
        Ok(_) => Ok(Read::Idle),
        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(Read::Idle),
        Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => Ok(Read::Closed),
        Err(e) => Err(e.to_string()),
    }
}

fn now_s() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Run EventSub until `stop` is set or the connection ends. Follows Twitch's reconnect message.
/// `subscribe_fn` is called with the session ID once the welcome arrives.
pub fn run_eventsub(stop: &AtomicBool, mut subscribe_fn: impl FnMut(&str), mut on_event: impl FnMut(Event)) -> Result<(), String> {
    let mut url = EVENTSUB_URL.to_owned();
    let mut dedup = Dedup::default();
    let mut subscribed = false;
    'outer: while !stop.load(Ordering::Relaxed) {
        let mut socket = connect(&url, eventsub::MAX_MESSAGE)?;
        let mut last = std::time::Instant::now();
        let mut keepalive = 30u64;
        loop {
            if stop.load(Ordering::Relaxed) {
                let _ = socket.close(None);
                break 'outer;
            }
            match read(&mut socket)? {
                Read::Text(t) => {
                    last = std::time::Instant::now();
                    match eventsub::parse(&t, &mut dedup, now_s())? {
                        Message::Welcome { session_id, keepalive_s } => {
                            keepalive = keepalive_s.max(10);
                            // After a reconnect, Twitch carries the subscriptions over.
                            if !subscribed {
                                subscribe_fn(&session_id);
                                subscribed = true;
                            }
                        }
                        Message::Reconnect { url: next } => {
                            url = next;
                            continue 'outer;
                        }
                        Message::Notification(ev) => on_event(ev),
                        Message::Revoked { .. } | Message::Keepalive | Message::Ignored(_) => {}
                    }
                }
                Read::Idle => {
                    // No message within keepalive + grace: the connection is dead.
                    if last.elapsed() > Duration::from_secs(keepalive + 10) {
                        return Err("EventSub keepalive missed".into());
                    }
                }
                Read::Closed => return Err("EventSub connection closed".into()),
            }
        }
    }
    Ok(())
}

/// Run chat. `auth` = Some((token, login)) signs in; None joins anonymously (read-only).
pub fn run_irc(stop: &AtomicBool, auth: Option<(&str, &str)>, channel: &str, mut on_line: impl FnMut(irc::IrcMessage)) -> Result<(), String> {
    if channel.is_empty() || channel.len() > 25 || !channel.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err("invalid channel name".into());
    }
    let mut socket = connect(IRC_URL, 64 * 1024)?;
    let (pass, nick) = match auth {
        Some((token, login)) => (format!("PASS oauth:{token}"), format!("NICK {login}")),
        None => ("PASS SCHMOOPIIE".to_owned(), "NICK justinfan54321".to_owned()),
    };
    for line in [
        "CAP REQ :twitch.tv/tags twitch.tv/commands".to_owned(),
        pass,
        nick,
        format!("JOIN #{}", channel.to_ascii_lowercase()),
    ] {
        socket.send(WsMessage::text(line)).map_err(|e| e.to_string())?;
    }
    while !stop.load(Ordering::Relaxed) {
        match read(&mut socket)? {
            Read::Text(t) => {
                for raw in t.split("\r\n").filter(|l| !l.is_empty()) {
                    let Some(m) = irc::parse(raw) else { continue };
                    match m.command.as_str() {
                        "PING" => socket
                            .send(WsMessage::text(format!("PONG :{}", m.trailing.as_deref().unwrap_or("tmi.twitch.tv"))))
                            .map_err(|e| e.to_string())?,
                        "NOTICE" if m.trailing.as_deref().is_some_and(|t| t.contains("Login authentication failed")) => {
                            return Err("Twitch chat sign-in failed".into());
                        }
                        "RECONNECT" => return Err("Twitch asked chat to reconnect".into()),
                        _ => on_line(m),
                    }
                }
            }
            Read::Idle => {}
            Read::Closed => return Err("chat connection closed".into()),
        }
    }
    let _ = socket.close(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn viewer_counts() {
        assert_eq!(parse_viewers(r#"{"data":[{"viewer_count":812,"type":"live"}],"pagination":{}}"#), Ok(Some(812)));
        assert_eq!(parse_viewers(r#"{"data":[],"pagination":{}}"#), Ok(None), "offline");
        assert!(parse_viewers("<html>").is_err());
        assert!(viewers("token", "12a").is_err(), "user ID must be numeric");
    }

    #[test]
    fn conditions_per_type() {
        assert_eq!(condition("channel.raid", "42"), json!({ "to_broadcaster_user_id": "42" }));
        assert_eq!(condition("channel.follow", "42")["moderator_user_id"], "42");
        assert_eq!(condition("channel.cheer", "42"), json!({ "broadcaster_user_id": "42" }));
        assert!(oauth::valid_client_id(CLIENT_ID));
    }

    /// Live, no sign-in needed: EventSub greets any client with a session (no subscriptions made).
    #[test]
    #[ignore = "network: connects to Twitch EventSub"]
    fn live_eventsub_welcome() {
        let stop = AtomicBool::new(false);
        let mut session = String::new();
        let r = run_eventsub(
            &stop,
            |id| {
                session = id.to_owned();
                stop.store(true, Ordering::Relaxed);
            },
            |_| {},
        );
        assert!(r.is_ok(), "{r:?}");
        assert!(!session.is_empty(), "welcome received");
    }

    /// Live, no sign-in needed: anonymous read-only chat join.
    #[test]
    #[ignore = "network: joins a Twitch chat anonymously"]
    fn live_irc_anonymous_join() {
        let stop = AtomicBool::new(false);
        let mut joined = false;
        let r = run_irc(&stop, None, "twitch", |m| {
            if m.command == "JOIN" || m.command == "ROOMSTATE" || m.command == "001" {
                joined = true;
                stop.store(true, Ordering::Relaxed);
            }
        });
        assert!(r.is_ok(), "{r:?}");
        assert!(joined);
    }
}
