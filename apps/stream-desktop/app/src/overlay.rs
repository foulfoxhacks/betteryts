//! Local overlay server for OBS browser sources: loopback HTTP only (std, no extra crates).
//! `GET /overlay` serves the page; the page reads its token from the URL #fragment (never sent to
//! a server) and polls `GET /state` with an `X-Overlay-Token` header. Host must be loopback
//! (DNS-rebinding guard); no CORS headers, so other web pages can't read the state.

use bys_discord::PresenceInput;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PORT: u16 = 47823;
const ALERT_MS: u128 = 8_000;

static ALERT: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);

/// Show a line on the overlay for a few seconds (automation output `overlay.alert`).
pub fn set_alert(text: String) {
    if let Ok(mut a) = ALERT.lock() {
        *a = Some((text, std::time::Instant::now()));
    }
}

fn current_alert() -> Option<String> {
    ALERT
        .lock()
        .ok()?
        .as_ref()
        .filter(|(_, t)| t.elapsed().as_millis() < ALERT_MS)
        .map(|(s, _)| s.clone())
}
const PAGE: &str = include_str!("../ui/local-overlay.html");

/// A fresh 256-bit token as hex.
pub fn new_token() -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// Status, content type, body for one request (pure, so it is testable without sockets).
pub fn respond(method: &str, path: &str, host: &str, token_header: &str, token: &str, input: &PresenceInput) -> (u16, &'static str, String) {
    let host_ok = [format!("127.0.0.1:{PORT}"), format!("localhost:{PORT}")].iter().any(|h| h == host);
    if !host_ok {
        return (421, "text/plain", "wrong host".into());
    }
    match (method, path) {
        ("GET", "/overlay") => (200, "text/html; charset=utf-8", PAGE.into()),
        ("GET", "/state") if !token.is_empty() && same(token_header, token) => {
            let track = input
                .track
                .as_ref()
                .map(|t| json!({ "title": t.title, "artist": t.artist, "artwork": t.artwork }));
            let body = json!({ "live": input.live, "requestsOpen": input.requests_open, "queueLength": input.queue_length, "nowPlaying": track, "lastTrigger": input.last_trigger, "audience": input.audience, "alert": current_alert() });
            (200, "application/json", body.to_string())
        }
        ("GET", "/state") => (401, "text/plain", "overlay token required".into()),
        _ => (404, "text/plain", "not found".into()),
    }
}

fn handle(stream: TcpStream, token: &str, input: &Mutex<PresenceInput>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let (mut line, mut host, mut tok) = (String::new(), String::new(), String::new());
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
    for _ in 0..50 {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() || h.len() > 4096 {
            break;
        }
        let (k, v) = h.split_once(':').unwrap_or(("", ""));
        match k.trim().to_ascii_lowercase().as_str() {
            "host" => host = v.trim().to_owned(),
            "x-overlay-token" => tok = v.trim().to_owned(),
            _ => {}
        }
    }
    let path = target.split('?').next().unwrap_or("");
    let snapshot = input.lock().map(|i| i.clone()).unwrap_or_default();
    let (status, ctype, body) = respond(&method, path, &host, &tok, token, &snapshot);
    let mut out = stream;
    write!(
        out,
        "HTTP/1.1 {status} OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://i.ytimg.com https://lh3.googleusercontent.com; connect-src 'self'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// Serve on 127.0.0.1:PORT for the life of the app. One connection at a time is plenty for OBS.
pub fn spawn(token: String, input: Arc<Mutex<PresenceInput>>) {
    let started = std::thread::Builder::new().name("bys-overlay".into()).spawn(move || {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT)) else {
            eprintln!("BetterYTS Stream: overlay port {PORT} is in use");
            return;
        };
        for stream in listener.incoming().flatten() {
            let _ = handle(stream, &token, &input);
        }
    });
    if let Err(e) = started {
        eprintln!("BetterYTS Stream: overlay server could not start: {e}");
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    const H: &str = "127.0.0.1:47823";

    #[test]
    fn token_host_and_routes() {
        let t = new_token().unwrap();
        assert_eq!(t.len(), 64);
        let input = PresenceInput {
            live: true,
            queue_length: 3,
            ..Default::default()
        };
        assert_eq!(respond("GET", "/overlay", H, "", &t, &input).0, 200, "page is public, data is not");
        assert_eq!(respond("GET", "/state", H, "", &t, &input).0, 401);
        assert_eq!(respond("GET", "/state", H, &"0".repeat(64), &t, &input).0, 401);
        let (code, _, body) = respond("GET", "/state", H, &t, &t, &input);
        assert_eq!(code, 200);
        assert!(body.contains("\"queueLength\":3"));
        assert_eq!(respond("GET", "/state", "evil.example:47823", &t, &t, &input).0, 421, "DNS rebinding blocked");
        assert_eq!(respond("POST", "/state", H, &t, &t, &input).0, 404);
        assert_eq!(respond("GET", "/state", H, "", "", &input).0, 401, "an empty token never matches");
    }
}
