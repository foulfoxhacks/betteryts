//! Local storage for BetterYTS Stream Desktop (blueprint §6).
//!
//! * [`Settings`]: non-secret preferences in a JSON file, written atomically (temp file + rename),
//!   schema-versioned, readable only by the current user on Unix.
//! * [`Secrets`]: credentials go to the OS keychain ([`Keychain`]) and nowhere else. They never
//!   appear in the settings file, logs or exports. [`MemorySecrets`] is for tests.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCHEMA: u32 = 1;
/// Settings larger than this are refused (a settings file is a few KiB).
pub const MAX_SETTINGS: u64 = 256 * 1024;

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    /// The file exists but isn't valid settings. It is left untouched for the user to inspect.
    Corrupt(String),
    TooLarge,
    NewerSchema(u32),
    Secret(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "settings file: {e}"),
            StoreError::Corrupt(e) => write!(f, "settings file is damaged ({e}); it was left as is"),
            StoreError::TooLarge => write!(f, "settings file is unexpectedly large"),
            StoreError::NewerSchema(v) => write!(f, "settings were saved by a newer version (schema {v}); update the app"),
            StoreError::Secret(e) => write!(f, "keychain: {e}"),
        }
    }
}
impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

/// Profile card on the Get Live screen.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    pub display_name: String,
    pub handle: String,
    pub venue: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PearSettings {
    pub enabled: bool,
    /// Pear Desktop's local API, loopback only.
    pub host: String,
}

impl Default for PearSettings {
    fn default() -> Self {
        PearSettings {
            enabled: false,
            host: "http://127.0.0.1:26538".into(),
        }
    }
}

/// Discord Rich Presence fields; everything can be switched off. Names are hidden by default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DiscordSettings {
    pub enabled: bool,
    pub show_now_playing: bool,
    pub show_audience: bool,
    pub show_requests: bool,
    pub show_triggers: bool,
    pub show_viewer_names: bool,
}

impl Default for DiscordSettings {
    fn default() -> Self {
        DiscordSettings {
            enabled: false,
            show_now_playing: true,
            show_audience: true,
            show_requests: true,
            show_triggers: true,
            show_viewer_names: false,
        }
    }
}

/// TikTok through TikFinity's local WebSocket (owner's chosen TikTok source).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TikFinitySettings {
    pub enabled: bool,
    pub url: String,
}

impl Default for TikFinitySettings {
    fn default() -> Self {
        TikFinitySettings {
            enabled: false,
            url: "ws://127.0.0.1:21213/".into(),
        }
    }
}

/// Twitch connection (tokens are in the keychain, not here).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TwitchSettings {
    pub enabled: bool,
    /// Reply in Twitch chat with each request's result (needs a sign-in with the write scope).
    pub replies: bool,
    pub login: String,
    pub user_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub schema: u32,
    pub api_origin: String,
    /// Current BetterYTS Stream session code (not secret; its credential is in the keychain).
    pub session_code: Option<String>,
    pub profile: Profile,
    pub pear: PearSettings,
    pub discord: DiscordSettings,
    pub twitch: TwitchSettings,
    pub tikfinity: TikFinitySettings,
    /// Which request types the Get Live toggles accept.
    pub accept_songs: bool,
    pub accept_videos: bool,
    pub accept_shoutouts: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema: SCHEMA,
            api_origin: "https://yts.foulfoxhacks.dev".into(),
            session_code: None,
            profile: Profile::default(),
            pear: PearSettings::default(),
            discord: DiscordSettings::default(),
            twitch: TwitchSettings::default(),
            tikfinity: TikFinitySettings::default(),
            accept_songs: true,
            accept_videos: false,
            accept_shoutouts: false,
        }
    }
}

impl Settings {
    /// Missing file → defaults. Damaged file → error (never silently replaced).
    pub fn load(path: &Path) -> Result<Settings, StoreError> {
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
            Err(e) => return Err(e.into()),
        };
        if meta.len() > MAX_SETTINGS {
            return Err(StoreError::TooLarge);
        }
        let text = fs::read_to_string(path)?;
        let settings: Settings = serde_json::from_str(&text).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        if settings.schema > SCHEMA {
            return Err(StoreError::NewerSchema(settings.schema));
        }
        Ok(Settings { schema: SCHEMA, ..settings })
    }

    /// Atomic save: write a temp file next to the target, flush to disk, then rename over it.
    pub fn save(&self, path: &Path) -> Result<(), StoreError> {
        let dir = path.parent().ok_or_else(|| StoreError::Corrupt("settings path has no folder".into()))?;
        fs::create_dir_all(dir)?;
        let text = serde_json::to_string_pretty(self).map_err(|e| StoreError::Corrupt(e.to_string()))?;
        let tmp: PathBuf = dir.join(format!(".{}.tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json")));
        {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// Names of everything kept in the keychain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Secret {
    /// Owner credential for the current BetterYTS Stream session.
    SessionCredential,
    /// Scoped destination credential (playback), when the owner made one.
    DestinationCredential,
    /// Token for the local API (Phase 3).
    LocalApiToken,
    /// Pear Desktop API Server access token.
    PearToken,
    /// Twitch user access token and its (rotating) refresh token.
    TwitchAccess,
    TwitchRefresh,
}

impl Secret {
    fn key(self) -> &'static str {
        match self {
            Secret::SessionCredential => "stream-session",
            Secret::DestinationCredential => "stream-destination",
            Secret::LocalApiToken => "local-api",
            Secret::PearToken => "pear-desktop",
            Secret::TwitchAccess => "twitch-access",
            Secret::TwitchRefresh => "twitch-refresh",
        }
    }
}

/// Where secrets live. Implementations must never write them to plain files.
pub trait Secrets: Send + Sync {
    fn get(&self, which: Secret) -> Result<Option<String>, StoreError>;
    fn set(&self, which: Secret, value: &str) -> Result<(), StoreError>;
    fn delete(&self, which: Secret) -> Result<(), StoreError>;
}

/// The OS keychain: Windows Credential Manager, or Secret Service (GNOME Keyring / KWallet) on Linux.
#[cfg(any(windows, target_os = "linux"))]
#[derive(Debug, Clone)]
pub struct Keychain {
    service: String,
}

#[cfg(any(windows, target_os = "linux"))]
impl Keychain {
    pub fn new() -> Self {
        Keychain {
            service: "BetterYTS Stream".into(),
        }
    }
    fn entry(&self, which: Secret) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(&self.service, which.key()).map_err(|e| StoreError::Secret(e.to_string()))
    }
}

#[cfg(any(windows, target_os = "linux"))]
impl Default for Keychain {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(any(windows, target_os = "linux"))]
impl Secrets for Keychain {
    fn get(&self, which: Secret) -> Result<Option<String>, StoreError> {
        match self.entry(which)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(StoreError::Secret(e.to_string())),
        }
    }
    fn set(&self, which: Secret, value: &str) -> Result<(), StoreError> {
        self.entry(which)?.set_password(value).map_err(|e| StoreError::Secret(e.to_string()))
    }
    fn delete(&self, which: Secret) -> Result<(), StoreError> {
        match self.entry(which)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(StoreError::Secret(e.to_string())),
        }
    }
}

/// In-memory secrets for tests and for "don't remember" sessions.
#[derive(Debug, Default)]
pub struct MemorySecrets(Mutex<HashMap<Secret, String>>);

impl Secrets for MemorySecrets {
    fn get(&self, which: Secret) -> Result<Option<String>, StoreError> {
        Ok(self.0.lock().map_err(|_| StoreError::Secret("lock poisoned".into()))?.get(&which).cloned())
    }
    fn set(&self, which: Secret, value: &str) -> Result<(), StoreError> {
        self.0
            .lock()
            .map_err(|_| StoreError::Secret("lock poisoned".into()))?
            .insert(which, value.to_owned());
        Ok(())
    }
    fn delete(&self, which: Secret) -> Result<(), StoreError> {
        self.0.lock().map_err(|_| StoreError::Secret("lock poisoned".into()))?.remove(&which);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bys-store-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn missing_file_gives_defaults_and_save_round_trips() {
        let d = dir("roundtrip");
        let p = d.join("settings.json");
        let mut s = Settings::load(&p).unwrap();
        assert_eq!(s, Settings::default());
        assert!(!s.discord.show_viewer_names, "names hidden by default");
        s.profile.display_name = "DJ Fox".into();
        s.session_code = Some("ABCD2345".into());
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p).unwrap(), s);
        assert!(!d.join(".settings.json.tmp").exists(), "temp file renamed away");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn damaged_large_or_newer_files_are_not_overwritten() {
        let d = dir("bad");
        fs::create_dir_all(&d).unwrap();
        let p = d.join("settings.json");
        fs::write(&p, "{not json").unwrap();
        assert!(matches!(Settings::load(&p), Err(StoreError::Corrupt(_))));
        assert_eq!(fs::read_to_string(&p).unwrap(), "{not json", "left for the user");
        fs::write(&p, r#"{"schema": 99}"#).unwrap();
        assert!(matches!(Settings::load(&p), Err(StoreError::NewerSchema(99))));
        fs::write(&p, vec![b' '; (MAX_SETTINGS + 1) as usize]).unwrap();
        assert!(matches!(Settings::load(&p), Err(StoreError::TooLarge)));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_fields_are_ignored_and_missing_ones_default() {
        let d = dir("partial");
        fs::create_dir_all(&d).unwrap();
        let p = d.join("settings.json");
        fs::write(&p, r#"{"schema":1,"profile":{"venue":"Milo's"},"futureThing":true}"#).unwrap();
        let s = Settings::load(&p).unwrap();
        assert_eq!(s.profile.venue, "Milo's");
        assert!(s.accept_songs);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn secrets_never_touch_the_settings_file() {
        let d = dir("secrets");
        let p = d.join("settings.json");
        let secrets = MemorySecrets::default();
        secrets.set(Secret::SessionCredential, "a-very-secret-credential").unwrap();
        Settings::default().save(&p).unwrap();
        assert!(!fs::read_to_string(&p).unwrap().contains("a-very-secret-credential"));
        assert_eq!(secrets.get(Secret::SessionCredential).unwrap().as_deref(), Some("a-very-secret-credential"));
        secrets.delete(Secret::SessionCredential).unwrap();
        assert_eq!(secrets.get(Secret::SessionCredential).unwrap(), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn settings_file_is_private_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("perm");
        let p = d.join("settings.json");
        Settings::default().save(&p).unwrap();
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&d);
    }

    /// Touches the real OS keychain: `cargo test -p bys-store -- --ignored keychain`.
    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    #[ignore = "uses the real OS keychain"]
    fn keychain_round_trip() {
        let k = Keychain {
            service: "BetterYTS Stream (test)".into(),
        };
        k.set(Secret::LocalApiToken, "test-value").unwrap();
        assert_eq!(k.get(Secret::LocalApiToken).unwrap().as_deref(), Some("test-value"));
        k.delete(Secret::LocalApiToken).unwrap();
        assert_eq!(k.get(Secret::LocalApiToken).unwrap(), None);
    }
}
