//! BetterYTS Stream Desktop: the native app shell. The UI (ui/) only calls the commands below;
//! everything that touches the network or secrets lives here, in Rust.
//!
//! Security notes (blueprint §6–§7):
//! - The session credential lives only in the OS keychain; commands never return it to the UI.
//! - Errors shown in the UI are plain messages and never contain credentials.
//! - Network calls run on a blocking worker thread, never on the UI thread.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod automation;
mod chat;
mod overlay;
mod playback;
mod presence;
mod streamerbot;
mod tikfinity;
mod twitch;

use bys_store::{Profile, Secret, Secrets, Settings};
use bys_stream_api::{Action, Client, Credential, HttpTransport, Kinds, Manage, QueueState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct AppState {
    settings: Arc<Mutex<Settings>>,
    path: PathBuf,
    secrets: Arc<dyn Secrets>,
    player: Arc<Mutex<playback::PlayerStatus>>,
    presence: Arc<Mutex<bys_discord::PresenceInput>>,
    twitch: Arc<twitch::Shared>,
    tikfinity: Arc<Mutex<tikfinity::TikFinityStatus>>,
    streamerbot: Arc<Mutex<streamerbot::SbStatus>>,
}

type Res<T> = Result<T, String>;

fn lock(state: &AppState) -> Res<std::sync::MutexGuard<'_, Settings>> {
    state.settings.lock().map_err(|_| "settings are unavailable; restart the app".to_owned())
}

fn client(origin: &str) -> Res<Client<HttpTransport>> {
    Client::new(origin, HttpTransport::default()).map_err(|e| e.to_string())
}

/// The current session code and its credential from the keychain.
fn session(state: &AppState) -> Res<(String, String, Credential)> {
    let settings = lock(state)?;
    let code = settings.session_code.clone().ok_or("Connect or create a session first.")?;
    let raw = state
        .secrets
        .get(Secret::SessionCredential)
        .map_err(|e| e.to_string())?
        .ok_or("This session's credential isn't saved. Connect again.")?;
    let cred = Credential::new(&raw).map_err(|e| e.to_string())?;
    Ok((settings.api_origin.clone(), code, cred))
}

/// Run blocking network work off the UI thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "the request was interrupted".to_owned())?
}

fn save(state: &AppState, settings: &Settings) -> Res<()> {
    settings.save(&state.path).map_err(|e| e.to_string())
}

fn limit(value: &str, max: usize) -> String {
    value.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_owned()
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Res<Settings> {
    Ok(lock(&state)?.clone())
}

#[tauri::command]
fn save_profile(state: tauri::State<'_, AppState>, profile: Profile) -> Res<Settings> {
    let mut s = lock(&state)?;
    s.profile = Profile {
        display_name: limit(&profile.display_name, 60),
        handle: limit(&profile.handle, 60),
        venue: limit(&profile.venue, 80),
    };
    save(&state, &s)?;
    Ok(s.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Connected {
    code: String,
}

#[tauri::command]
async fn create_session(state: tauri::State<'_, AppState>, minutes: u32) -> Res<Connected> {
    let origin = lock(&state)?.api_origin.clone();
    let created = blocking(move || client(&origin)?.create_session(minutes, None).map_err(|e| e.to_string())).await?;
    state
        .secrets
        .set(Secret::SessionCredential, created.owner_token.expose())
        .map_err(|e| e.to_string())?;
    let mut s = lock(&state)?;
    s.session_code = Some(created.view.code.clone());
    save(&state, &s)?;
    Ok(Connected { code: created.view.code })
}

#[tauri::command]
async fn connect_session(state: tauri::State<'_, AppState>, code: String, credential: String) -> Res<Connected> {
    let code = code.trim().to_uppercase();
    let cred = Credential::new(&credential).map_err(|e| e.to_string())?;
    let origin = lock(&state)?.api_origin.clone();
    // Prove the credential works before saving it.
    let (c, k) = (code.clone(), cred.clone());
    blocking(move || client(&origin)?.queue(&c, &k).map_err(|e| e.to_string())).await?;
    state.secrets.set(Secret::SessionCredential, cred.expose()).map_err(|e| e.to_string())?;
    let mut s = lock(&state)?;
    s.session_code = Some(code.clone());
    save(&state, &s)?;
    Ok(Connected { code })
}

#[tauri::command]
fn forget_session(state: tauri::State<'_, AppState>) -> Res<()> {
    state.secrets.delete(Secret::SessionCredential).map_err(|e| e.to_string())?;
    let mut s = lock(&state)?;
    s.session_code = None;
    save(&state, &s)
}

#[tauri::command]
async fn queue_state(state: tauri::State<'_, AppState>) -> Res<QueueState> {
    let (origin, code, cred) = session(&state)?;
    let q = blocking(move || client(&origin)?.queue(&code, &cred).map_err(|e| e.to_string())).await?;
    if let Ok(mut p) = state.presence.lock() {
        let live = !q.view.ended;
        if live && !p.live {
            p.live_since = Some(presence::now_s());
        }
        p.live = live;
        p.requests_open = q.intake;
        p.queue_length = q.active.iter().filter(|e| e.state == "queued" || e.state == "pending_approval").count() as u64;
        p.played = q.stats.completed;
    }
    Ok(q)
}

#[tauri::command]
async fn moderate(state: tauri::State<'_, AppState>, action: String, id: Option<String>, position: Option<u32>) -> Res<()> {
    let action = match action.as_str() {
        "approve" => Action::Approve,
        "reject" => Action::Reject,
        "remove" => Action::Remove,
        "complete" => Action::Complete,
        "skip" => Action::Skip,
        "reorder" => Action::Reorder,
        "clear" => Action::Clear,
        _ => return Err("unknown action".into()),
    };
    let (origin, code, cred) = session(&state)?;
    blocking(move || {
        client(&origin)?
            .moderate(&code, &cred, action, id.as_deref(), position, None)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
}

/// Master switch: Go live / Pause (all request kinds).
#[tauri::command]
async fn set_live(state: tauri::State<'_, AppState>, on: bool) -> Res<()> {
    let (origin, code, cred) = session(&state)?;
    let update = Manage {
        intake: Some(on),
        ..Default::default()
    };
    blocking(move || client(&origin)?.manage(&code, &cred, &update).map(|_| ()).map_err(|e| e.to_string())).await
}

/// Per-kind switches: songs, videos, shoutouts.
#[tauri::command]
async fn set_kinds(state: tauri::State<'_, AppState>, songs: bool, videos: bool, shoutouts: bool) -> Res<()> {
    {
        let mut s = lock(&state)?;
        s.accept_songs = songs;
        s.accept_videos = videos;
        s.accept_shoutouts = shoutouts;
        save(&state, &s)?;
    }
    let (origin, code, cred) = session(&state)?;
    let update = Manage {
        kinds: Some(Kinds {
            song: songs,
            video: videos,
            shoutout: shoutouts,
        }),
        ..Default::default()
    };
    blocking(move || client(&origin)?.manage(&code, &cred, &update).map(|_| ()).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn end_session(state: tauri::State<'_, AppState>) -> Res<()> {
    let (origin, code, cred) = session(&state)?;
    let update = Manage {
        end: Some(true),
        ..Default::default()
    };
    blocking(move || client(&origin)?.manage(&code, &cred, &update).map(|_| ()).map_err(|e| e.to_string())).await?;
    forget_session(state)
}

#[tauri::command]
fn player_status(state: tauri::State<'_, AppState>) -> Res<playback::PlayerStatus> {
    state.player.lock().map(|p| p.clone()).map_err(|_| "player status unavailable".to_owned())
}

/// Ask Pear Desktop for an access token; the user approves it inside Pear within two minutes.
#[tauri::command]
async fn pear_connect(state: tauri::State<'_, AppState>) -> Res<()> {
    let host = lock(&state)?.pear.host.clone();
    let token = blocking(move || playback::authorize(&host)).await?;
    state.secrets.set(Secret::PearToken, &token).map_err(|e| e.to_string())?;
    let mut s = lock(&state)?;
    s.pear.enabled = true;
    save(&state, &s)
}

#[tauri::command]
fn pear_disconnect(state: tauri::State<'_, AppState>) -> Res<()> {
    state.secrets.delete(Secret::PearToken).map_err(|e| e.to_string())?;
    let mut s = lock(&state)?;
    s.pear.enabled = false;
    save(&state, &s)
}

#[tauri::command]
fn set_discord(state: tauri::State<'_, AppState>, enabled: bool) -> Res<Settings> {
    let mut s = lock(&state)?;
    s.discord.enabled = enabled;
    save(&state, &s)?;
    Ok(s.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TwitchCode {
    user_code: String,
    verification_uri: String,
}

/// Start Twitch sign-in: the console shows the code; the user enters it at twitch.tv/activate.
#[tauri::command]
async fn twitch_connect(state: tauri::State<'_, AppState>) -> Res<TwitchCode> {
    let shared = state.twitch.clone();
    let code = blocking(move || twitch::sign_in(shared)).await?;
    Ok(TwitchCode {
        user_code: code.user_code,
        verification_uri: code.verification_uri,
    })
}

#[tauri::command]
fn twitch_status(state: tauri::State<'_, AppState>) -> Res<twitch::TwitchStatus> {
    state
        .twitch
        .status
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "Twitch status unavailable".to_owned())
}

#[tauri::command]
fn twitch_disconnect(state: tauri::State<'_, AppState>) -> Res<()> {
    twitch::sign_out(&state.twitch)
}

#[tauri::command]
fn tikfinity_status(state: tauri::State<'_, AppState>) -> Res<tikfinity::TikFinityStatus> {
    state.tikfinity.lock().map(|s| s.clone()).map_err(|_| "TikFinity status unavailable".to_owned())
}

/// Turn the TikFinity source on or off (TikFinity must be running on this computer).
#[tauri::command]
fn set_tikfinity(state: tauri::State<'_, AppState>, enabled: bool) -> Res<Settings> {
    let mut s = lock(&state)?;
    s.tikfinity.enabled = enabled;
    save(&state, &s)?;
    Ok(s.clone())
}

/// Chat replies need the write scope, so turning them on means connecting Twitch again.
#[tauri::command]
fn set_twitch_replies(state: tauri::State<'_, AppState>, on: bool) -> Res<Settings> {
    let mut s = lock(&state)?;
    s.twitch.replies = on;
    save(&state, &s)?;
    Ok(s.clone())
}

/// The OBS browser-source address for the local overlay (token in the #fragment).
#[tauri::command]
fn overlay_url(state: tauri::State<'_, AppState>) -> Res<String> {
    let token = state.secrets.get(Secret::OverlayToken).map_err(|e| e.to_string())?.ok_or("overlay not ready")?;
    Ok(format!("http://127.0.0.1:{}/overlay#{token}", overlay::PORT))
}

#[tauri::command]
fn streamerbot_status(state: tauri::State<'_, AppState>) -> Res<streamerbot::SbStatus> {
    state
        .streamerbot
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "Streamer.bot status unavailable".to_owned())
}

#[tauri::command]
fn set_streamerbot(state: tauri::State<'_, AppState>, enabled: bool) -> Res<Settings> {
    let mut s = lock(&state)?;
    s.streamerbot.enabled = enabled;
    save(&state, &s)?;
    Ok(s.clone())
}

#[tauri::command]
fn chains_get() -> Res<String> {
    automation::chains_json(&automation::current())
}

/// Validate and save chains JSON (also used for import); the engine reloads immediately.
#[tauri::command]
fn chains_save(state: tauri::State<'_, AppState>, json: String) -> Res<usize> {
    let path = state.path.with_file_name("chains.json");
    automation::save(&path, &json)
}

fn main() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            let path = dir.join("settings.json");
            // A damaged settings file is reported, not overwritten: start with defaults in memory only.
            let settings = Settings::load(&path).unwrap_or_default();
            #[cfg(any(windows, target_os = "linux"))]
            let secrets: Arc<dyn Secrets> = Arc::new(bys_store::Keychain::new());
            #[cfg(not(any(windows, target_os = "linux")))]
            let secrets: Arc<dyn Secrets> = Arc::new(bys_store::MemorySecrets::default());
            let settings = Arc::new(Mutex::new(settings));
            let player = Arc::new(Mutex::new(playback::PlayerStatus::default()));
            let presence = Arc::new(Mutex::new(bys_discord::PresenceInput::default()));
            playback::spawn(settings.clone(), secrets.clone(), player.clone(), presence.clone());
            presence::spawn(settings.clone(), presence.clone());
            // Automation engine (chains come from the Phase 3 editor; none yet).
            // Saved chains; a damaged file is reported and nothing runs (the file is left as is).
            let chains = automation::load(&dir.join("chains.json")).unwrap_or_else(|e| {
                eprintln!("BetterYTS Stream: {e}");
                Vec::new()
            });

            // Local overlay: reuse the saved token, or make one and keep it in the keychain.
            let overlay_token = match secrets.get(Secret::OverlayToken).ok().flatten() {
                Some(t) => t,
                None => {
                    let t = overlay::new_token()?;
                    secrets.set(Secret::OverlayToken, &t).map_err(|e| e.to_string())?;
                    t
                }
            };
            overlay::spawn(overlay_token, presence.clone());
            let twitch = Arc::new(twitch::Shared {
                settings: settings.clone(),
                path: path.clone(),
                secrets: secrets.clone(),
                status: Arc::new(Mutex::new(twitch::TwitchStatus::default())),
                presence: presence.clone(),
                live: Mutex::new(None),
                last_reply: Mutex::new(None),
            });
            twitch::spawn(twitch.clone());
            let chat_twitch = twitch.clone();
            automation::init(presence.clone(), chains, Box::new(move |t: &str| twitch::reply(&chat_twitch, t)))?;
            let sb_status = Arc::new(Mutex::new(streamerbot::SbStatus::default()));
            streamerbot::spawn(settings.clone(), secrets.clone(), sb_status.clone());
            let tikfinity_status = Arc::new(Mutex::new(tikfinity::TikFinityStatus::default()));
            tikfinity::spawn(Arc::new(tikfinity::Shared {
                settings: settings.clone(),
                secrets: secrets.clone(),
                status: tikfinity_status.clone(),
                presence: presence.clone(),
            }));
            app.manage(AppState {
                settings,
                path,
                secrets,
                player,
                presence,
                twitch,
                tikfinity: tikfinity_status,
                streamerbot: sb_status,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_profile,
            create_session,
            connect_session,
            forget_session,
            queue_state,
            moderate,
            set_live,
            set_kinds,
            end_session,
            player_status,
            pear_connect,
            pear_disconnect,
            set_discord,
            twitch_connect,
            twitch_status,
            twitch_disconnect,
            tikfinity_status,
            set_tikfinity,
            set_twitch_replies,
            overlay_url,
            streamerbot_status,
            set_streamerbot,
            chains_get,
            chains_save
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("BetterYTS Stream could not start: {e}");
        std::process::exit(1);
    }
}
