//! BetterYTS Stream engine core. Design: `docs/stream/desktop-blueprint.md`.
//!
//! Flow: a source adapter builds an [`event::Event`] → [`Engine::handle`] finds matching enabled
//! chains → cooldowns → [`chain::plan`] expands each into a bounded timeline →
//! [`governor::Governor::check`] accepts or rejects the whole timeline → the runtime executes
//! accepted plans (cancellable by emergency stop). This crate has no I/O and no dependencies.

pub mod chain;
pub mod condition;
pub mod event;
pub mod governor;

use chain::{Chain, Plan, PlanError, Rng};
use event::Event;
use governor::{Governor, Origin, Rejection};
use std::collections::HashMap;

/// What happened to one matching chain for one event. Every outcome is meant for the audit log.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Accepted { chain: String, plan: Plan },
    Cooldown { chain: String, remaining_ms: u64 },
    PlanFailed { chain: String, error: PlanError },
    Refused { chain: String, reason: Rejection },
}

#[derive(Debug, Default)]
pub struct Engine {
    chains: Vec<Chain>,
    pub governor: Governor,
    last_run: HashMap<String, u64>,
    last_run_by_user: HashMap<(String, String), u64>,
}

pub const MAX_CHAINS: usize = 500;

impl Engine {
    pub fn new(governor: Governor) -> Self {
        Engine {
            governor,
            ..Default::default()
        }
    }

    /// Replace the chain set (validated: unique IDs, bounded count, valid trigger conditions).
    pub fn set_chains(&mut self, chains: Vec<Chain>) -> Result<(), String> {
        if chains.len() > MAX_CHAINS {
            return Err(format!("at most {MAX_CHAINS} chains"));
        }
        let mut seen = std::collections::HashSet::new();
        for c in &chains {
            if c.id.is_empty() || c.id.len() > 64 || !seen.insert(c.id.clone()) {
                return Err(format!("chain id {:?} is empty, too long or duplicated", c.id));
            }
            c.trigger.when.validate().map_err(|e| format!("{}: {e}", c.id))?;
        }
        self.chains = chains;
        Ok(())
    }

    pub fn chains(&self) -> &[Chain] {
        &self.chains
    }

    /// Process one event at `now_ms`. Accepted plans are recorded by the governor and cooldowns
    /// start; the caller schedules their actions relative to `now_ms`.
    pub fn handle(&mut self, ev: &Event, now_ms: u64, rng: &mut impl Rng) -> Vec<Outcome> {
        let origin = if ev.is_owner_origin() { Origin::Owner } else { Origin::Audience };
        let user = ev.actor.as_ref().map(|a| format!("{}:{}", ev.platform.as_str(), a.id));
        let mut out = Vec::new();
        for chain in self.chains.iter().filter(|c| c.enabled && c.trigger.matches(ev)) {
            let since = |last: Option<&u64>, cd: u64| last.map(|t| (t.saturating_add(cd)).saturating_sub(now_ms)).filter(|r| *r > 0);
            if let Some(remaining_ms) = since(self.last_run.get(&chain.id), chain.cooldown_ms) {
                out.push(Outcome::Cooldown {
                    chain: chain.id.clone(),
                    remaining_ms,
                });
                continue;
            }
            if let Some(u) = &user
                && let Some(remaining_ms) = since(self.last_run_by_user.get(&(chain.id.clone(), u.clone())), chain.per_user_cooldown_ms)
            {
                out.push(Outcome::Cooldown {
                    chain: chain.id.clone(),
                    remaining_ms,
                });
                continue;
            }
            let planned = match chain::plan(chain, ev, rng) {
                Ok(p) => p,
                Err(error) => {
                    out.push(Outcome::PlanFailed {
                        chain: chain.id.clone(),
                        error,
                    });
                    continue;
                }
            };
            match self.governor.check(&planned, origin, now_ms) {
                Ok(plan) => {
                    self.last_run.insert(chain.id.clone(), now_ms);
                    if let Some(u) = &user {
                        self.last_run_by_user.insert((chain.id.clone(), u.clone()), now_ms);
                    }
                    out.push(Outcome::Accepted { chain: chain.id.clone(), plan });
                }
                Err(reason) => out.push(Outcome::Refused {
                    chain: chain.id.clone(),
                    reason,
                }),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;
    use chain::{Action, Command, Step, Trigger, XorShift};
    use condition::Cond;
    use event::{EventKind, Platform, RawEvent, Role};
    use governor::OutputLimits;

    fn gift(user: &str) -> Event {
        Event::new(
            Platform::TikTok,
            EventKind::Gift,
            RawEvent {
                id: "g",
                actor: Some((user, user, Role::Viewer)),
                amount: 10.0,
                ..Default::default()
            },
        )
        .unwrap()
    }
    fn chain(id: &str, output: &str, cd: u64, user_cd: u64) -> Chain {
        Chain {
            id: id.into(),
            name: id.into(),
            enabled: true,
            trigger: Trigger {
                kinds: vec![EventKind::Gift],
                platforms: vec![],
                when: Cond::Always,
            },
            steps: vec![Step::Do(Action {
                output: output.into(),
                command: Command::Text("thanks!".into()),
            })],
            cooldown_ms: cd,
            per_user_cooldown_ms: user_cd,
        }
    }

    #[test]
    fn gifts_run_chains_with_cooldowns_and_safety() {
        let mut g = Governor::new();
        g.configure("chat", OutputLimits::digital_default());
        g.configure(
            "toy",
            OutputLimits {
                enabled: true,
                ..OutputLimits::physical_default()
            },
        );
        let mut e = Engine::new(g);
        e.set_chains(vec![chain("thank", "chat", 0, 5_000), chain("buzz", "toy", 0, 0)]).unwrap();
        let mut rng = XorShift::new(3);

        let first = e.handle(&gift("a"), 0, &mut rng);
        assert!(matches!(&first[0], Outcome::Accepted { chain, .. } if chain == "thank"));
        assert!(
            matches!(
                &first[1],
                Outcome::Refused {
                    reason: Rejection::AudienceNotAllowed(_),
                    ..
                }
            ),
            "viewers can't reach the toy"
        );

        assert!(
            matches!(&e.handle(&gift("a"), 1_000, &mut rng)[0], Outcome::Cooldown { remaining_ms: 4_000, .. }),
            "same user"
        );
        assert!(matches!(&e.handle(&gift("b"), 1_000, &mut rng)[0], Outcome::Accepted { .. }), "another user");
    }

    #[test]
    fn chain_sets_are_validated() {
        let mut e = Engine::default();
        assert!(e.set_chains(vec![chain("x", "chat", 0, 0), chain("x", "chat", 0, 0)]).is_err());
        assert!(e.set_chains(vec![chain("", "chat", 0, 0)]).is_err());
    }
}
