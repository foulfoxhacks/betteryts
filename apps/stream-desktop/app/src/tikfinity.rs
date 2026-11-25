//! TikTok through TikFinity (owner's choice): supervised loopback WebSocket. Chat commands become
//! requests, gifts / likes / follows / shares become triggers, room viewers feed Discord presence.

use bys_store::{Secrets, Settings};
use bys_tiktok::{TikTokEvent, tikfinity, to_event};
use serde::Serialize;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TikFinityStatus {
    /// "off", "connecting", "connected", "error".
    pub state: String,
    pub last_event: Option<String>,
    pub error: Option<String>,
    pub viewers: Option<u64>,
}

pub struct Shared {
    pub settings: Arc<Mutex<Settings>>,
    pub secrets: Arc<dyn Secrets>,
    pub status: Arc<Mutex<TikFinityStatus>>,
    pub presence: Arc<Mutex<bys_discord::PresenceInput>>,
}

fn set(status: &Mutex<TikFinityStatus>, f: impl FnOnce(&mut TikFinityStatus)) {
    if let Ok(mut s) = status.lock() {
        f(&mut s);
    }
}

fn on_event(shared: &Shared, ev: TikTokEvent) {
    if let TikTokEvent::ViewerCount(n) = ev {
        set(&shared.status, |s| s.viewers = Some(n));
        if let Ok(mut p) = shared.presence.lock() {
            p.audience.retain(|(name, _)| name != "TikTok");
            p.audience.push(("TikTok".into(), n));
        }
        return;
    }
    let Some(Ok(event)) = to_event(&ev) else { return };
    let Some(line) = crate::chat::route(&shared.settings, shared.secrets.as_ref(), &event) else {
        return;
    };
    if event.kind != bys_core::event::EventKind::Chat
        && let Ok(mut p) = shared.presence.lock()
    {
        p.last_trigger = Some(line.clone());
    }
    set(&shared.status, |s| s.last_event = Some(line));
}

/// Keeps the TikFinity connection up while enabled; backs off 5 s → 60 s when TikFinity isn't running.
pub fn spawn(shared: Arc<Shared>) {
    let started = std::thread::Builder::new().name("bys-tikfinity".into()).spawn(move || {
        let mut backoff = 5;
        loop {
            let config = shared.settings.lock().map(|s| s.tikfinity.clone()).ok();
            let Some(cfg) = config.filter(|c| c.enabled) else {
                set(&shared.status, |s| {
                    *s = TikFinityStatus {
                        state: "off".into(),
                        ..Default::default()
                    }
                });
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            set(&shared.status, |s| s.state = "connecting".into());
            // Stop when switched off: a watcher flips this flag.
            let stop = Arc::new(AtomicBool::new(false));
            let watcher = {
                let (settings, stop) = (shared.settings.clone(), stop.clone());
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        if !settings.lock().map(|s| s.tikfinity.enabled).unwrap_or(false) {
                            stop.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                        std::thread::sleep(Duration::from_secs(1));
                    }
                })
            };
            let status = shared.status.clone();
            let result = tikfinity::run(&cfg.url, &stop, |ev| {
                set(&status, |s| {
                    s.state = "connected".into();
                    s.error = None;
                });
                on_event(&shared, ev);
            });
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = watcher.join();
            if let Err(e) = result {
                set(&shared.status, |s| {
                    s.state = "error".into();
                    s.error = Some(e);
                });
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(60);
            } else {
                backoff = 5;
            }
        }
    });
    if let Err(e) = started {
        eprintln!("BetterYTS Stream: TikFinity source could not start: {e}");
    }
}
