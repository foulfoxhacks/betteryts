//! Background playback loop: this desktop is the BetterYTS Stream "destination" for Pear Desktop.
//! Every few seconds it sends a heartbeat + claim; a claimed request is added to Pear with
//! verification (`bys_player::dispatch`) and the outcome is reported back. A request is never sent
//! twice: the server hands each claim out once and the dispatcher never retries a write.

use bys_player::{HttpTransport as PearHttp, NowPlaying, Pear, PearError};
use bys_store::{Secret, Secrets, Settings};
use bys_stream_api::{Client, Credential, HttpTransport, Outcome, Report};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PEAR_CLIENT_ID: &str = "betteryts-stream";
const TICK: Duration = Duration::from_secs(3);

/// What the console (and later Discord presence) shows about playback.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    /// "off", "not_authorized", "unreachable", "ready".
    pub state: String,
    pub last_result: Option<String>,
    pub now_playing: Option<Playing>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playing {
    pub title: String,
    pub artist: String,
    pub duration_s: Option<u32>,
    pub elapsed_s: Option<u32>,
    pub paused: Option<bool>,
    pub artwork: Option<String>,
}

impl From<NowPlaying> for Playing {
    fn from(n: NowPlaying) -> Self {
        Playing {
            title: n.title,
            artist: n.artist,
            duration_s: n.duration_s,
            elapsed_s: n.elapsed_s,
            paused: n.paused,
            artwork: n.artwork,
        }
    }
}

fn set(status: &Mutex<PlayerStatus>, f: impl FnOnce(&mut PlayerStatus)) {
    if let Ok(mut s) = status.lock() {
        f(&mut s);
    }
}

/// One loop iteration. Returns quietly on every error; the status explains what's wrong.
fn tick(settings: &Mutex<Settings>, secrets: &dyn Secrets, status: &Mutex<PlayerStatus>, presence: &Mutex<bys_discord::PresenceInput>) {
    let Ok(s) = settings.lock().map(|s| s.clone()) else { return };
    if !s.pear.enabled {
        set(status, |st| {
            *st = PlayerStatus {
                state: "off".into(),
                ..Default::default()
            }
        });
        return;
    }
    let Ok(Some(pear_token)) = secrets.get(Secret::PearToken) else {
        set(status, |st| st.state = "not_authorized".into());
        return;
    };
    let Ok(pear) = Pear::new(&s.pear.host, Some(pear_token), PearHttp::default()) else {
        set(status, |st| st.state = "unreachable".into());
        return;
    };
    let ready = match pear.now_playing() {
        Ok(now) => {
            if let Ok(mut p) = presence.lock() {
                p.track = now.as_ref().map(|n| bys_discord::Track {
                    title: n.title.clone(),
                    artist: n.artist.clone(),
                    requester: None,
                    duration_s: n.duration_s,
                    elapsed_s: n.elapsed_s,
                    paused: n.paused.unwrap_or(false),
                    artwork: n.artwork.clone(),
                });
            }
            set(status, |st| {
                st.state = "ready".into();
                st.now_playing = now.map(Playing::from);
            });
            true
        }
        Err(PearError::Unauthorized) => {
            set(status, |st| st.state = "not_authorized".into());
            false
        }
        Err(_) => {
            set(status, |st| st.state = "unreachable".into());
            false
        }
    };
    // Heartbeat + claim only with a session; prefer the narrower destination credential.
    let Some(code) = s.session_code.clone() else { return };
    let raw = secrets
        .get(Secret::DestinationCredential)
        .ok()
        .flatten()
        .or_else(|| secrets.get(Secret::SessionCredential).ok().flatten());
    let Some(cred) = raw.and_then(|r| Credential::new(&r).ok()) else { return };
    let Ok(api) = Client::new(&s.api_origin, HttpTransport::default()) else {
        return;
    };
    let Ok(claim) = api.claim(&code, &cred, ready) else { return };
    let Some(request) = claim.request else { return };
    let result = bys_player::dispatch(&pear, &request.media.id, std::thread::sleep);
    let report = Report {
        id: request.id,
        outcome: if result.completed { Outcome::Completed } else { Outcome::Failed },
        code: result.code.to_owned(),
        message: result.message.clone(),
        uncertain: result.uncertain,
    };
    let line = format!("{} — {}", request.media.title, result.message);
    // A lost report leaves the request "dispatching" on the server; it is never re-sent.
    let _ = api.report(&code, &cred, &report);
    set(status, |st| st.last_result = Some(line));
}

/// Start the loop on its own thread for the life of the app.
pub fn spawn(settings: Arc<Mutex<Settings>>, secrets: Arc<dyn Secrets>, status: Arc<Mutex<PlayerStatus>>, presence: Arc<Mutex<bys_discord::PresenceInput>>) {
    std::thread::Builder::new()
        .name("bys-playback".into())
        .spawn(move || {
            loop {
                tick(&settings, secrets.as_ref(), &status, &presence);
                std::thread::sleep(TICK);
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| eprintln!("BetterYTS Stream: playback loop could not start: {e}"));
}

/// One-time Pear authorization (the user clicks "Allow" in Pear Desktop within two minutes).
pub fn authorize(host: &str) -> Result<String, String> {
    let pear = Pear::new(host, None, PearHttp::with_timeout(Duration::from_secs(120))).map_err(|e| e.to_string())?;
    pear.request_token(PEAR_CLIENT_ID).map_err(|e| e.to_string())
}
