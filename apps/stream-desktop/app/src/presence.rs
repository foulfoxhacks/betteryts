//! Discord Rich Presence loop. Reads the shared [`PresenceInput`] (fed by the queue poll and the
//! playback loop), and pushes an update at most every 15 seconds, only when it changed. Talks to the
//! local Discord app only; turning presence off clears it.

use bys_discord::{PresenceInput, Show};
use bys_store::Settings;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn spawn(settings: Arc<Mutex<Settings>>, input: Arc<Mutex<PresenceInput>>) {
    let started = std::thread::Builder::new().name("bys-discord".into()).spawn(move || {
        let mut session = None;
        let mut last_sent: Option<Option<serde_json::Value>> = None;
        loop {
            let config = settings.lock().map(|s| s.discord.clone()).ok();
            match config {
                Some(d) if d.enabled => {
                    let show = Show {
                        now_playing: d.show_now_playing,
                        audience: d.show_audience,
                        requests: d.show_requests,
                        triggers: d.show_triggers,
                        viewer_names: d.show_viewer_names,
                    };
                    let snapshot = input.lock().map(|i| i.clone()).unwrap_or_default();
                    let activity = bys_discord::activity(&snapshot, show, now_s());
                    if session.is_none() {
                        session = bys_discord::connect().ok();
                        last_sent = None;
                    }
                    if let Some(s) = session.as_mut()
                        && last_sent.as_ref() != Some(&activity)
                    {
                        match s.set_activity(activity.as_ref()) {
                            Ok(()) => last_sent = Some(activity),
                            Err(_) => session = None, // Discord closed or restarted: reconnect next round.
                        }
                    }
                }
                _ => {
                    if let Some(mut s) = session.take() {
                        let _ = s.set_activity(None);
                    }
                    last_sent = None;
                }
            }
            std::thread::sleep(Duration::from_millis(bys_discord::MIN_INTERVAL_MS));
        }
    });
    if let Err(e) = started {
        eprintln!("BetterYTS Stream: Discord presence could not start: {e}");
    }
}
