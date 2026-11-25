//! Automation plumbing: every source event goes through `bys_core::Engine` (trigger match →
//! cooldowns → planner → safety governor). Outputs wired so far: `console` (text shown as the last
//! trigger in the console, Discord presence and the overlay). Chains are loaded by the Phase 3
//! editor; until then the chain list is empty and nothing runs.

use bys_core::chain::{Chain, Command, XorShift};
use bys_core::event::Event;
use bys_core::governor::{Governor, OutputLimits};
use bys_core::{Engine, Outcome};
use bys_discord::PresenceInput;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Sink = Box<dyn Fn(&str) + Send + Sync>;

struct State {
    engine: Mutex<Engine>,
    presence: Arc<Mutex<PresenceInput>>,
    /// Posts to Twitch chat (honours the Replies switch and its rate limit).
    chat: Sink,
    /// Runs one OBS action (loopback obs-websocket, password from the keychain).
    obs: Box<dyn Fn(bys_obs::ObsAction) + Send + Sync>,
}

static STATE: OnceLock<State> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Outputs automation text can go to.
/// `obs.scene` text = scene name; `obs.text` text = "Source name|text".
pub const OUTPUTS: [&str; 5] = ["console", "twitch.chat", "overlay.alert", "obs.scene", "obs.text"];

/// Text actions (delay ms, output, text) from one event's accepted plans.
pub fn texts(engine: &mut Engine, ev: &Event, now: u64) -> Vec<(u64, String, String)> {
    let mut rng = XorShift::new(now ^ 0x5bd1_e995);
    engine
        .handle(ev, now, &mut rng)
        .into_iter()
        .filter_map(|o| if let Outcome::Accepted { plan, .. } = o { Some(plan) } else { None })
        .flat_map(|plan| plan.actions)
        .filter_map(|p| match p.action.command {
            Command::Text(t) if OUTPUTS.contains(&p.action.output.as_str()) => Some((p.at_ms, p.action.output, t.chars().take(200).collect())),
            _ => None,
        })
        .collect()
}

pub const CHAINS_SCHEMA: u32 = 1;
pub const MAX_CHAINS_FILE: usize = 512 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
struct ChainsFile {
    schema: u32,
    chains: Vec<Chain>,
}

/// Parse and validate chains JSON (size cap; serde_json's nesting limit; engine validation).
pub fn parse_chains(json: &str) -> Result<Vec<Chain>, String> {
    if json.len() > MAX_CHAINS_FILE {
        return Err("chains file is larger than 512 KB".into());
    }
    let f: ChainsFile = serde_json::from_str(json).map_err(|e| format!("chains file is invalid: {e}"))?;
    if f.schema != CHAINS_SCHEMA {
        return Err(format!("chains file schema {} isn't supported", f.schema));
    }
    Engine::default().set_chains(f.chains.clone())?;
    Ok(f.chains)
}

pub fn chains_json(chains: &[Chain]) -> Result<String, String> {
    serde_json::to_string_pretty(&ChainsFile {
        schema: CHAINS_SCHEMA,
        chains: chains.to_vec(),
    })
    .map_err(|e| e.to_string())
}

/// Missing file = no chains. A damaged file is an error and is left untouched.
pub fn load(path: &Path) -> Result<Vec<Chain>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => parse_chains(&s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Validate, save atomically, then swap the engine's chains.
pub fn save(path: &Path, json: &str) -> Result<usize, String> {
    let chains = parse_chains(json)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, chains_json(&chains)?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    if let Some(state) = STATE.get() {
        state.engine.lock().map_err(|_| "engine unavailable".to_owned())?.set_chains(chains.clone())?;
    }
    Ok(chains.len())
}

pub fn current() -> Vec<Chain> {
    STATE.get().and_then(|s| s.engine.lock().ok().map(|e| e.chains().to_vec())).unwrap_or_default()
}

pub fn init(presence: Arc<Mutex<PresenceInput>>, chains: Vec<Chain>, chat: Sink, obs: Box<dyn Fn(bys_obs::ObsAction) + Send + Sync>) -> Result<(), String> {
    let mut governor = Governor::new();
    governor.configure(
        "console",
        OutputLimits {
            max_per_minute: 30,
            ..OutputLimits::digital_default()
        },
    );
    governor.configure(
        "twitch.chat",
        OutputLimits {
            max_per_minute: 20,
            ..OutputLimits::digital_default()
        },
    );
    governor.configure(
        "overlay.alert",
        OutputLimits {
            max_per_minute: 60,
            ..OutputLimits::digital_default()
        },
    );
    governor.configure(
        "obs.scene",
        OutputLimits {
            max_per_minute: 10,
            ..OutputLimits::digital_default()
        },
    );
    governor.configure(
        "obs.text",
        OutputLimits {
            max_per_minute: 30,
            ..OutputLimits::digital_default()
        },
    );
    let mut engine = Engine::new(governor);
    engine.set_chains(chains)?;
    let _ = STATE.set(State {
        engine: Mutex::new(engine),
        presence,
        chat,
        obs,
    });
    Ok(())
}

/// Feed one source event; each text goes to its output at its planned time.
pub fn feed(ev: &Event) {
    let Some(state) = STATE.get() else { return };
    let Ok(list) = state.engine.lock().map(|mut e| texts(&mut e, ev, now_ms())) else {
        return;
    };
    for (delay, output, text) in list {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            let Some(state) = STATE.get() else { return };
            match output.as_str() {
                "twitch.chat" => (state.chat)(&text),
                "overlay.alert" => crate::overlay::set_alert(text),
                "obs.scene" => (state.obs)(bys_obs::ObsAction::Scene(text)),
                "obs.text" => {
                    if let Some((source, value)) = text.split_once('|') {
                        (state.obs)(bys_obs::ObsAction::Text(source.trim().to_owned(), value.to_owned()));
                    }
                }
                _ => {
                    if let Ok(mut p) = state.presence.lock() {
                        p.last_trigger = Some(text);
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]
    use super::*;
    use bys_core::chain::{Action, Step, Trigger};
    use bys_core::condition::Cond;
    use bys_core::event::{EventKind, Platform, RawEvent, Role};

    #[test]
    fn chains_round_trip_and_bad_files_are_refused() {
        let json = r#"{"schema":1,"chains":[{"id":"thanks","name":"Thank gifters","enabled":true,
            "trigger":{"kinds":["gift"],"platforms":["tiktok"],"when":{"ge":[{"field":"amount"},{"const":10}]}},
            "steps":[{"do":{"output":"console","command":{"text":"Thank you!"}}},{"delay":{"ms":500}},
                     {"random":[[1,[{"do":{"output":"console","command":{"text":"Big gift!"}}}]]]}],
            "cooldown_ms":0,"per_user_cooldown_ms":5000}]}"#;
        let chains = parse_chains(json).unwrap();
        assert_eq!(chains[0].trigger.platforms, vec![bys_core::event::Platform::TikTok]);
        assert_eq!(parse_chains(&chains_json(&chains).unwrap()).unwrap(), chains, "round trip");
        assert!(parse_chains(r#"{"schema":2,"chains":[]}"#).is_err());
        assert!(parse_chains(&json.replace("\"id\":\"thanks\"", "\"id\":\"\"")).is_err(), "empty id");
        assert!(parse_chains(&"x".repeat(MAX_CHAINS_FILE + 1)).is_err());
        let deep = format!(
            "{{\"schema\":1,\"chains\":[{{\"id\":\"d\",\"name\":\"d\",\"enabled\":true,\"trigger\":{{\"kinds\":[\"gift\"],\"platforms\":[],\"when\":{}\"always\"{}}},\"steps\":[],\"cooldown_ms\":0,\"per_user_cooldown_ms\":0}}]}}",
            "{\"not\":".repeat(300),
            "}".repeat(300)
        );
        assert!(parse_chains(&deep).is_err(), "deep nesting refused");
    }

    /// Exactly what the Automations editor saves (captured from ui/automations.js), so the UI and
    /// the Rust schema can't drift apart.
    #[test]
    fn editor_payload_parses() {
        let ui = r#"{"schema":1,"chains":[{"id":"adv","name":"Imported raid party","enabled":true,"trigger":{"kinds":["raid"],"platforms":[],"when":"always"},"steps":[{"random":[[1,[]]]}],"cooldown_ms":0,"per_user_cooldown_ms":0},{"id":"cmwwik5fy","name":"Thank gifters <b>x</b>","enabled":true,"trigger":{"kinds":["gift"],"platforms":["tiktok"],"when":{"ge":[{"field":"amount"},{"const":10}]}},"steps":[{"do":{"output":"console","command":{"text":"Thank you!"}}},{"delay":{"ms":1500}},{"do":{"output":"console","command":{"text":"Gift goal +1"}}}],"cooldown_ms":0,"per_user_cooldown_ms":0}]}"#;
        let chains = parse_chains(ui).unwrap();
        assert_eq!(chains.len(), 2);
        assert_eq!(chains[1].steps.len(), 3);
    }

    #[test]
    fn gift_chain_reaches_the_console_through_the_governor() {
        let mut g = Governor::new();
        g.configure("console", OutputLimits::digital_default());
        let mut e = Engine::new(g);
        let say = |t: &str| {
            Step::Do(Action {
                output: "console".into(),
                command: Command::Text(t.into()),
            })
        };
        let toy = Step::Do(Action {
            output: "toy".into(),
            command: Command::Text("buzz".into()),
        });
        e.set_chains(vec![
            Chain {
                id: "thanks".into(),
                name: "Thank gifters".into(),
                enabled: true,
                trigger: Trigger {
                    kinds: vec![EventKind::Gift],
                    platforms: vec![],
                    when: Cond::Always,
                },
                steps: vec![say("Thank you!"), Step::Delay { ms: 500 }, say("Gift goal +1")],
                cooldown_ms: 0,
                per_user_cooldown_ms: 0,
            },
            Chain {
                id: "unsafe".into(),
                name: "x".into(),
                enabled: true,
                trigger: Trigger {
                    kinds: vec![EventKind::Gift],
                    platforms: vec![],
                    when: Cond::Always,
                },
                steps: vec![toy],
                cooldown_ms: 0,
                per_user_cooldown_ms: 0,
            },
        ])
        .unwrap();
        let gift = Event::new(
            Platform::TikTok,
            EventKind::Gift,
            RawEvent {
                id: "g1",
                actor: Some(("1", "fan", Role::Viewer)),
                amount: 5.0,
                ..Default::default()
            },
        )
        .unwrap();
        let out = texts(&mut e, &gift, 1_000);
        assert_eq!(
            out,
            vec![(0, "console".into(), "Thank you!".into()), (500, "console".into(), "Gift goal +1".into())],
            "unknown outputs are refused by the governor"
        );
    }

    #[test]
    fn new_outputs_pass_the_governor() {
        let mut g = Governor::new();
        for o in OUTPUTS {
            g.configure(o, OutputLimits::digital_default());
        }
        let mut e = Engine::new(g);
        let step = |o: &str| {
            Step::Do(Action {
                output: o.into(),
                command: Command::Text(o.into()),
            })
        };
        e.set_chains(vec![Chain {
            id: "x".into(),
            name: "x".into(),
            enabled: true,
            trigger: Trigger {
                kinds: vec![EventKind::Follow],
                platforms: vec![],
                when: Cond::Always,
            },
            steps: vec![step("twitch.chat"), step("overlay.alert")],
            cooldown_ms: 0,
            per_user_cooldown_ms: 0,
        }])
        .unwrap();
        let ev = Event::new(
            Platform::Twitch,
            EventKind::Follow,
            RawEvent {
                id: "f1",
                actor: Some(("1", "fan", Role::Viewer)),
                ..Default::default()
            },
        )
        .unwrap();
        let outs: Vec<String> = texts(&mut e, &ev, 0).into_iter().map(|(_, o, _)| o).collect();
        assert_eq!(outs, vec!["twitch.chat".to_owned(), "overlay.alert".to_owned()]);
    }
}
