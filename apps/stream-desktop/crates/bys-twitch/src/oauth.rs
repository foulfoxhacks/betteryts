//! Twitch OAuth device code flow (for public clients: no client secret on the user's machine).
//! The app shows `user_code` and `verification_uri`; the user approves on twitch.tv; the app polls
//! the token endpoint. This module builds the requests and interprets the answers; the HTTP calls
//! happen in the app with its HTTPS client.

use serde::Deserialize;

pub const DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
pub const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
pub const VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
pub const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Read-only scopes for chat and EventSub. `user:write:chat` is added only when chat replies are on.
pub fn scopes(chat_replies: bool) -> String {
    let mut s = vec![
        "user:read:chat",
        "chat:read",
        "moderator:read:followers",
        "channel:read:subscriptions",
        "bits:read",
        "channel:read:redemptions",
    ];
    if chat_replies {
        s.extend(["user:write:chat", "chat:edit"]);
    }
    s.join(" ")
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

/// application/x-www-form-urlencoded escaping.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn valid_client_id(id: &str) -> bool {
    (20..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Body for POST [`DEVICE_URL`].
pub fn device_request(client_id: &str, chat_replies: bool) -> Result<String, String> {
    if !valid_client_id(client_id) {
        return Err("the Twitch client ID looks wrong".into());
    }
    Ok(form(&[("client_id", client_id), ("scopes", &scopes(chat_replies))]))
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

pub fn parse_device(json: &str) -> Result<DeviceCode, String> {
    let d: DeviceCode = serde_json::from_str(json).map_err(|_| "Twitch returned an unexpected device code response".to_owned())?;
    // Only send the user to Twitch's own activation page.
    if !d.verification_uri.starts_with("https://www.twitch.tv/activate") {
        return Err("unexpected verification address".into());
    }
    Ok(d)
}

/// Body for polling POST [`TOKEN_URL`].
pub fn token_request(client_id: &str, device_code: &str, chat_replies: bool) -> String {
    form(&[
        ("client_id", client_id),
        ("scopes", &scopes(chat_replies)),
        ("device_code", device_code),
        ("grant_type", DEVICE_GRANT),
    ])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    Granted {
        access_token: String,
        refresh_token: String,
        expires_in: u64,
    },
    /// Keep polling at the given interval.
    Pending,
    /// Poll more slowly.
    SlowDown,
    Denied,
    Expired,
    Failed(String),
}

#[derive(Deserialize)]
struct TokenOk {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

/// Interpret one token poll (status + body).
pub fn parse_poll(status: u16, body: &str) -> Poll {
    if status == 200 {
        return match serde_json::from_str::<TokenOk>(body) {
            Ok(t) if !t.access_token.is_empty() => Poll::Granted {
                access_token: t.access_token,
                refresh_token: t.refresh_token,
                expires_in: t.expires_in,
            },
            _ => Poll::Failed("Twitch returned an unexpected token response".into()),
        };
    }
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_owned))
        .unwrap_or_default();
    match message.as_str() {
        "authorization_pending" => Poll::Pending,
        "slow_down" => Poll::SlowDown,
        "access_denied" => Poll::Denied,
        "invalid device code" | "expired_token" => Poll::Expired,
        other => Poll::Failed(other.chars().take(200).collect()),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    const ID: &str = "abcdefghijklmnopqrstuvwxyz0123";

    #[test]
    fn scopes_are_minimal() {
        assert!(!scopes(false).contains("write"), "read-only unless replies are on");
        assert!(scopes(true).contains("user:write:chat"));
        assert!(!scopes(true).contains("channel:manage"), "never broad management scopes");
    }

    #[test]
    fn requests_are_form_encoded_and_validated() {
        let body = device_request(ID, false).unwrap();
        assert!(body.starts_with(&format!("client_id={ID}&scopes=user%3Aread%3Achat+chat%3Aread")));
        assert!(device_request("bad id!", false).is_err());
        assert!(token_request(ID, "dc&x", false).contains("device_code=dc%26x"), "values are escaped");
    }

    #[test]
    fn device_and_poll_responses() {
        let d = parse_device(
            r#"{"device_code":"d","user_code":"ABCD-EFGH","verification_uri":"https://www.twitch.tv/activate?public=true","expires_in":1800,"interval":5}"#,
        )
        .unwrap();
        assert_eq!(d.user_code, "ABCD-EFGH");
        assert!(parse_device(r#"{"device_code":"d","user_code":"X","verification_uri":"https://evil.example/activate","expires_in":1,"interval":5}"#).is_err());
        assert_eq!(parse_poll(400, r#"{"status":400,"message":"authorization_pending"}"#), Poll::Pending);
        assert_eq!(parse_poll(400, r#"{"status":400,"message":"slow_down"}"#), Poll::SlowDown);
        assert_eq!(parse_poll(400, r#"{"message":"access_denied"}"#), Poll::Denied);
        assert!(matches!(
            parse_poll(
                200,
                r#"{"access_token":"a","refresh_token":"r","expires_in":14400,"scope":[],"token_type":"bearer"}"#
            ),
            Poll::Granted { .. }
        ));
        assert!(matches!(parse_poll(200, "{}"), Poll::Failed(_)));
    }
}
