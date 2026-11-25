//! Automation plumbing: every source event goes through `bys_core::Engine` (trigger match →
//! cooldowns → planner → safety governor). Outputs wired so far: `console` (text shown as the last
//! trigger in the console, Discord presence and the overlay). Chains are loaded by the Phase 3
//! editor; until then the chain list is empty and nothing runs.

use bys_core::chain::{Chain, Command, XorShift};
use bys_core::event::Event;
use bys_core::governor::{Governor, OutputLimits};
use bys_core::{Engine, Outcome};
use bys_discord::PresenceInput;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct State {
    engine: Mutex<Engine>,
    presence: Arc<Mutex<PresenceInput>>,
}

static STATE: OnceLock<State> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Text actions (delay in ms, text) for the `console` output from one event's accepted plans.
pub fn console_texts(engine: &mut Engine, ev: &Event, now: u64) -> Vec<(u64, String)> {
    let mut rng = XorShift::new(now ^ 0x5bd1_e995);
    engine
        .handle(ev, now, &mut rng)
        .into_iter()
        .filter_map(|o| if let Outcome::Accepted { plan, .. } = o { Some(plan) } else { None })
        .flat_map(|plan| plan.actions)
        .filter_map(|p| match p.action.command {
            Command::Text(t) if p.action.output == "console" => Some((p.at_ms, t.chars().take(200).collect())),
            _ => None,
        })
        .collect()
}

pub fn init(presence: Arc<Mutex<PresenceInput>>, chains: Vec<Chain>) -> Result<(), String> {
    let mut governor = Governor::new();
    governor.configure(
        "console",
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
    });
    Ok(())
}

/// Feed one source event; console texts are shown at their planned times.
pub fn feed(ev: &Event) {
    let Some(state) = STATE.get() else { return };
    let texts = match state.engine.lock() {
        Ok(mut e) => console_texts(&mut e, ev, now_ms()),
        Err(_) => return,
    };
    for (delay, text) in texts {
        let presence = state.presence.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            if let Ok(mut p) = presence.lock() {
                p.last_trigger = Some(text);
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
        let texts = console_texts(&mut e, &gift, 1_000);
        assert_eq!(
            texts,
            vec![(0, "Thank you!".into()), (500, "Gift goal +1".into())],
            "unknown outputs are refused by the governor"
        );
    }
}
