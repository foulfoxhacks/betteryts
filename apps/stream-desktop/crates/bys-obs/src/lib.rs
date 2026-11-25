//! OBS control over obs-websocket v5 (OBS 28+, default `ws://127.0.0.1:4455`). One short connection
//! per action: Hello → Identify (with the v5 SHA-256 login when a password is set) → one Request →
//! its response → close. Loopback only; the password comes from the OS keychain.

use data_encoding::BASE64;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub const DEFAULT_URL: &str = "ws://127.0.0.1:4455";
const MAX_MESSAGE: usize = 256 * 1024;

/// What an automation can ask OBS to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObsAction {
    Scene(String),
    /// Set a text source's text: (input name, text).
    Text(String, String),
}

/// v5 login: base64(sha256(base64(sha256(password + salt)) + challenge)).
pub fn auth_string(password: &str, salt: &str, challenge: &str) -> String {
    let secret = BASE64.encode(&Sha256::digest(format!("{password}{salt}")));
    BASE64.encode(&Sha256::digest(format!("{secret}{challenge}")))
}

/// The Request message (op 6) for an action. Names and text are length-capped.
pub fn request(action: &ObsAction, id: &str) -> Value {
    let cap = |s: &str, n: usize| s.chars().filter(|c| !c.is_control() || *c == '\n').take(n).collect::<String>();
    let (kind, data) = match action {
        ObsAction::Scene(name) => ("SetCurrentProgramScene", json!({ "sceneName": cap(name, 200) })),
        ObsAction::Text(input, text) => (
            "SetInputSettings",
            json!({ "inputName": cap(input, 200), "inputSettings": { "text": cap(text, 500) } }),
        ),
    };
    json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } })
}

/// The Identify message (op 1) answering a Hello (op 0).
pub fn identify(hello: &Value, password: Option<&str>) -> Result<Value, String> {
    if hello.get("op").and_then(Value::as_u64) != Some(0) {
        return Err("OBS didn't greet as obs-websocket v5".into());
    }
    let mut d = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
    if let Some(auth) = hello.pointer("/d/authentication") {
        let (Some(salt), Some(challenge)) = (auth.get("salt").and_then(Value::as_str), auth.get("challenge").and_then(Value::as_str)) else {
            return Err("OBS sent an incomplete login challenge".into());
        };
        let pw = password
            .filter(|p| !p.is_empty())
            .ok_or("OBS asks for a password; add it in BetterYTS Stream settings")?;
        if let Some(obj) = d.as_object_mut() {
            obj.insert("authentication".into(), Value::String(auth_string(pw, salt, challenge)));
        }
    }
    Ok(json!({ "op": 1, "d": d }))
}

fn loopback(url: &str) -> bool {
    let rest = url.strip_prefix("ws://").unwrap_or("");
    !rest.contains(['@', '?', '#'])
        && ["127.0.0.1:", "localhost:", "[::1]:"].iter().any(|p| {
            rest.trim_end_matches('/')
                .strip_prefix(p)
                .is_some_and(|port| port.parse::<u16>().is_ok_and(|n| n > 0))
        })
}

/// Connect, log in, run one action, return OBS's answer.
pub fn run(url: &str, password: Option<&str>, action: &ObsAction) -> Result<(), String> {
    if !loopback(url) {
        return Err("OBS's address must be ws:// on this computer".into());
    }
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (mut ws, _) = tungstenite::client::connect_with_config(url, Some(config), 0).map_err(|e| format!("OBS isn't reachable ({e})"))?;
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_ref() {
        s.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    }
    let mut next = || -> Result<Value, String> {
        loop {
            match ws.read().map_err(|e| format!("OBS connection: {e}"))? {
                tungstenite::Message::Text(t) => return serde_json::from_str(t.as_str()).map_err(|_| "OBS sent invalid JSON".to_owned()),
                tungstenite::Message::Close(f) => {
                    return Err(format!(
                        "OBS closed the connection{}",
                        f.map(|f| format!(" ({})", f.reason)).unwrap_or_default()
                    ));
                }
                _ => {}
            }
        }
    };
    let hello = next()?;
    let ident = identify(&hello, password)?;
    drop(next);
    ws.send(tungstenite::Message::text(ident.to_string())).map_err(|e| e.to_string())?;
    let mut read = || -> Result<Value, String> {
        loop {
            if let tungstenite::Message::Text(t) = ws.read().map_err(|e| format!("OBS connection: {e}"))? {
                return serde_json::from_str(t.as_str()).map_err(|_| "OBS sent invalid JSON".to_owned());
            }
        }
    };
    if read()?.get("op").and_then(Value::as_u64) != Some(2) {
        return Err("OBS didn't accept the login (check the password)".into());
    }
    drop(read);
    ws.send(tungstenite::Message::text(request(action, "bys-1").to_string()))
        .map_err(|e| e.to_string())?;
    for _ in 0..20 {
        let Ok(tungstenite::Message::Text(t)) = ws.read() else { break };
        let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
        if v.get("op").and_then(Value::as_u64) == Some(7) {
            let _ = ws.close(None);
            return if v.pointer("/d/requestStatus/result").and_then(Value::as_bool) == Some(true) {
                Ok(())
            } else {
                Err(format!(
                    "OBS refused: {}",
                    v.pointer("/d/requestStatus/comment").and_then(Value::as_str).unwrap_or("unknown reason")
                ))
            };
        }
    }
    Err("OBS didn't answer the request".into())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn v5_auth_matches_the_published_algorithm() {
        // Expected value computed independently with Python hashlib + base64: base64(sha256(base64(sha256("supersecretpassword"+"lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=")) + "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=")).
        let a = auth_string(
            "supersecretpassword",
            "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
            "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=",
        );
        assert_eq!(a, "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=", "matches Python hashlib/base64");
        assert_eq!(
            a,
            auth_string(
                "supersecretpassword",
                "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
                "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY="
            )
        );
        assert_ne!(
            a,
            auth_string(
                "wrong",
                "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
                "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY="
            )
        );
    }

    #[test]
    fn identify_and_requests() {
        let open = json!({ "op": 0, "d": { "obsWebSocketVersion": "5.5.0", "rpcVersion": 1 } });
        assert!(identify(&open, None).unwrap().pointer("/d/authentication").is_none());
        let locked = json!({ "op": 0, "d": { "rpcVersion": 1, "authentication": { "salt": "s", "challenge": "c" } } });
        assert!(identify(&locked, None).is_err(), "password required");
        assert_eq!(
            identify(&locked, Some("pw"))
                .unwrap()
                .pointer("/d/authentication")
                .unwrap()
                .as_str()
                .unwrap()
                .len(),
            44
        );
        assert!(identify(&json!({ "op": 5 }), None).is_err());
        let r = request(&ObsAction::Scene("Starting Soon".into()), "id1");
        assert_eq!(r.pointer("/d/requestType").unwrap(), "SetCurrentProgramScene");
        let t = request(&ObsAction::Text("Now Playing".into(), "x".repeat(900)), "id2");
        assert_eq!(
            t.pointer("/d/requestData/inputSettings/text").unwrap().as_str().unwrap().len(),
            500,
            "text capped"
        );
    }

    #[test]
    fn loopback_only() {
        assert!(loopback(DEFAULT_URL) && loopback("ws://localhost:4455/"));
        for bad in [
            "ws://192.168.1.2:4455",
            "wss://127.0.0.1:4455",
            "ws://127.0.0.1.evil.com:4455",
            "ws://u@127.0.0.1:4455",
            "ws://127.0.0.1:0",
        ] {
            assert!(!loopback(bad), "{bad}");
        }
        assert!(run("ws://example.com:4455", None, &ObsAction::Scene("x".into())).is_err());
    }
}
