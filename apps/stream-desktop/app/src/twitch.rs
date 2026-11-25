//! Twitch in the app: device-flow sign-in, then a supervised background connection (EventSub +
//! chat). Chat commands become BetterYTS Stream requests; cheers, follows, subs and raids become
//! the console's / Discord's "last trigger" until the automation editor exists.
//!
//! Tokens live only in the OS keychain. The Twitch message ID is the request's event ID, so a
//! redelivered chat message is never queued twice (the server is idempotent on event IDs).

use bys_core::event::Event;
use bys_store::{Secret, Secrets, Settings};
use bys_twitch::{irc, live, oauth};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchStatus {
    /// "off", "waiting_for_approval", "connecting", "connected", "error".
    pub state: String,
    pub login: String,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub last_event: Option<String>,
    pub error: Option<String>,
    /// Live viewer count (None when offline or unknown).
    pub viewers: Option<u64>,
}

pub struct Shared {
    pub settings: Arc<Mutex<Settings>>,
    pub path: PathBuf,
    pub secrets: Arc<dyn Secrets>,
    pub status: Arc<Mutex<TwitchStatus>>,
    pub presence: Arc<Mutex<bys_discord::PresenceInput>>,
    /// (access token, user ID) of the running connection, for replies.
    pub live: Mutex<Option<(String, String)>>,
    pub last_reply: Mutex<Option<Instant>>,
}

fn set(status: &Mutex<TwitchStatus>, f: impl FnOnce(&mut TwitchStatus)) {
    if let Ok(mut s) = status.lock() {
        f(&mut s);
    }
}

/// Start sign-in: returns the code to show, and polls Twitch in the background until approved.
pub fn sign_in(shared: Arc<Shared>) -> Result<oauth::DeviceCode, String> {
    let replies = shared.settings.lock().map(|s| s.twitch.replies).unwrap_or(false);
    let code = live::device_start(replies)?;
    set(&shared.status, |s| {
        *s = TwitchStatus {
            state: "waiting_for_approval".into(),
            user_code: Some(code.user_code.clone()),
            verification_uri: Some(code.verification_uri.clone()),
            ..Default::default()
        };
    });
    let device = code.clone();
    std::thread::Builder::new()
        .name("bys-twitch-signin".into())
        .spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(device.expires_in.min(1800));
            let mut interval = device.interval.clamp(2, 30);
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_secs(interval));
                match live::device_poll(&device.device_code, replies) {
                    oauth::Poll::Pending => {}
                    oauth::Poll::SlowDown => interval += 5,
                    oauth::Poll::Granted {
                        access_token, refresh_token, ..
                    } => {
                        let result = live::validate(&access_token).and_then(|id| {
                            shared.secrets.set(Secret::TwitchAccess, &access_token).map_err(|e| e.to_string())?;
                            shared.secrets.set(Secret::TwitchRefresh, &refresh_token).map_err(|e| e.to_string())?;
                            let mut s = shared.settings.lock().map_err(|_| "settings unavailable".to_owned())?;
                            s.twitch = bys_store::TwitchSettings {
                                enabled: true,
                                replies: s.twitch.replies,
                                login: id.login.clone(),
                                user_id: id.user_id,
                            };
                            s.save(&shared.path).map_err(|e| e.to_string())?;
                            Ok(id.login)
                        });
                        match result {
                            Ok(login) => set(&shared.status, |s| {
                                *s = TwitchStatus {
                                    state: "connecting".into(),
                                    login,
                                    ..Default::default()
                                }
                            }),
                            Err(e) => set(&shared.status, |s| {
                                *s = TwitchStatus {
                                    state: "error".into(),
                                    error: Some(e),
                                    ..Default::default()
                                }
                            }),
                        }
                        return;
                    }
                    oauth::Poll::Denied => {
                        return set(&shared.status, |s| {
                            *s = TwitchStatus {
                                state: "error".into(),
                                error: Some("Sign-in was declined on Twitch.".into()),
                                ..Default::default()
                            }
                        });
                    }
                    oauth::Poll::Expired => break,
                    oauth::Poll::Failed(e) => {
                        return set(&shared.status, |s| {
                            *s = TwitchStatus {
                                state: "error".into(),
                                error: Some(e),
                                ..Default::default()
                            }
                        });
                    }
                }
            }
            set(&shared.status, |s| {
                *s = TwitchStatus {
                    state: "error".into(),
                    error: Some("The Twitch code expired. Try again.".into()),
                    ..Default::default()
                }
            });
        })
        .map_err(|e| e.to_string())?;
    Ok(code)
}

pub fn sign_out(shared: &Shared) -> Result<(), String> {
    shared.secrets.delete(Secret::TwitchAccess).map_err(|e| e.to_string())?;
    shared.secrets.delete(Secret::TwitchRefresh).map_err(|e| e.to_string())?;
    let mut s = shared.settings.lock().map_err(|_| "settings unavailable".to_owned())?;
    s.twitch = bys_store::TwitchSettings::default();
    s.save(&shared.path).map_err(|e| e.to_string())?;
    set(&shared.status, |st| {
        *st = TwitchStatus {
            state: "off".into(),
            ..Default::default()
        }
    });
    Ok(())
}

/// A valid access token: validates, refreshing once if Twitch says it expired.
fn token(shared: &Shared) -> Result<(String, live::Identity), String> {
    let access = shared
        .secrets
        .get(Secret::TwitchAccess)
        .map_err(|e| e.to_string())?
        .ok_or("not signed in to Twitch")?;
    match live::validate(&access) {
        Ok(id) => Ok((access, id)),
        Err(_) => {
            let refresh_token = shared
                .secrets
                .get(Secret::TwitchRefresh)
                .map_err(|e| e.to_string())?
                .ok_or("Twitch sign-in expired; connect again")?;
            match live::refresh(&refresh_token) {
                oauth::Poll::Granted {
                    access_token, refresh_token, ..
                } => {
                    shared.secrets.set(Secret::TwitchAccess, &access_token).map_err(|e| e.to_string())?;
                    shared.secrets.set(Secret::TwitchRefresh, &refresh_token).map_err(|e| e.to_string())?;
                    let id = live::validate(&access_token)?;
                    Ok((access_token, id))
                }
                _ => Err("Twitch sign-in expired; connect again".into()),
            }
        }
    }
}

fn on_event(shared: &Shared, ev: Event) {
    let Some(line) = crate::chat::route(&shared.settings, shared.secrets.as_ref(), &ev) else {
        return;
    };
    if ev.kind == bys_core::event::EventKind::Chat {
        reply(shared, &line);
    } else if let Ok(mut p) = shared.presence.lock() {
        p.last_trigger = Some(line.clone());
    }
    set(&shared.status, |s| s.last_event = Some(line));
}

/// Answer a chat request in Twitch chat, at most once every 1.5 s (extra replies are dropped).
fn reply(shared: &Shared, text: &str) {
    if !shared.settings.lock().map(|s| s.twitch.replies).unwrap_or(false) {
        return;
    }
    let Ok(mut last) = shared.last_reply.lock() else { return };
    if last.is_some_and(|t| t.elapsed() < Duration::from_millis(1500)) {
        return;
    }
    *last = Some(Instant::now());
    let Some((token, uid)) = shared.live.lock().ok().and_then(|l| l.clone()) else {
        return;
    };
    if let Err(e) = live::send_chat(&token, &uid, &uid, text) {
        set(&shared.status, |s| s.error = Some(e));
    }
}

fn enabled(shared: &Shared) -> bool {
    shared.settings.lock().map(|s| s.twitch.enabled).unwrap_or(false)
}

/// Supervisor: keeps EventSub and chat running while Twitch is enabled; backs off on errors.
pub fn spawn(shared: Arc<Shared>) {
    let started = std::thread::Builder::new().name("bys-twitch".into()).spawn(move || {
        let mut backoff = 5u64;
        loop {
            if !enabled(&shared) {
                if shared
                    .status
                    .lock()
                    .map(|s| s.state != "waiting_for_approval" && s.state != "error")
                    .unwrap_or(true)
                {
                    set(&shared.status, |s| s.state = "off".into());
                }
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let (access, id) = match token(&shared) {
                Ok(t) => t,
                Err(e) => {
                    set(&shared.status, |s| {
                        s.state = "error".into();
                        s.error = Some(e);
                    });
                    std::thread::sleep(Duration::from_secs(backoff));
                    backoff = (backoff * 2).min(300);
                    continue;
                }
            };
            if let Ok(mut l) = shared.live.lock() {
                *l = Some((access.clone(), id.user_id.clone()));
            }
            set(&shared.status, |s| {
                s.state = "connected".into();
                s.login = id.login.clone();
                s.error = None;
                s.user_code = None;
            });
            let stop = Arc::new(AtomicBool::new(false));
            let es = {
                let (shared, stop, access, uid) = (shared.clone(), stop.clone(), access.clone(), id.user_id.clone());
                std::thread::spawn(move || {
                    let r = live::run_eventsub(
                        &stop,
                        |session| {
                            for (kind, why) in live::subscribe(&access, session, &uid) {
                                set(&shared.status, |s| s.error = Some(format!("{kind}: {why}")));
                            }
                        },
                        |ev| on_event(&shared, ev),
                    );
                    stop.store(true, Ordering::Relaxed);
                    r
                })
            };
            let chat = {
                let (shared, stop, access, login) = (shared.clone(), stop.clone(), access.clone(), id.login.clone());
                std::thread::spawn(move || {
                    let r = live::run_irc(&stop, Some((&access, &login)), &login, |m| {
                        for ev in irc::to_events(&m).into_iter().flatten() {
                            on_event(&shared, ev);
                        }
                    });
                    stop.store(true, Ordering::Relaxed);
                    r
                })
            };
            // Watch for sign-out / disable, or either connection ending.
            let mut next_count = Instant::now();
            while enabled(&shared) && !stop.load(Ordering::Relaxed) {
                // Viewer count once a minute (Helix rate limits are far above this).
                if Instant::now() >= next_count {
                    next_count = Instant::now() + Duration::from_secs(60);
                    let n = live::viewers(&access, &id.user_id).unwrap_or(None);
                    set(&shared.status, |s| s.viewers = n);
                    if let Ok(mut p) = shared.presence.lock() {
                        p.audience.retain(|(name, _)| name != "Twitch");
                        if let Some(n) = n {
                            p.audience.push(("Twitch".into(), n));
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            stop.store(true, Ordering::Relaxed);
            let errors: Vec<String> = [es.join(), chat.join()].into_iter().filter_map(|r| r.ok().and_then(Result::err)).collect();
            if let Some(e) = errors.first() {
                set(&shared.status, |s| {
                    s.state = "error".into();
                    s.error = Some(e.clone());
                });
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(300);
            } else {
                backoff = 5;
            }
        }
    });
    if let Err(e) = started {
        eprintln!("BetterYTS Stream: Twitch could not start: {e}");
    }
}
