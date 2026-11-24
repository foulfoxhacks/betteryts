//! Safety governor (blueprint §8). Every plan passes through [`Governor::check`] before it runs;
//! there is no bypass. Limits are set by the owner only, unknown outputs are refused (fail closed),
//! and an emergency stop blocks everything except explicit stop commands until re-armed.

use crate::chain::{Command, Plan};
use std::collections::{HashMap, VecDeque};
use std::fmt;

/// Who asked for a run. Audience events can never reach physical outputs unless the owner allowed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Owner,
    Audience,
}

/// Owner-set limits for one output.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputLimits {
    pub enabled: bool,
    /// Physical outputs (haptics, shock, motors) get the strictest rules.
    pub physical: bool,
    /// Shock-type devices: off by default, needs `physical` too.
    pub electrical: bool,
    pub audience_may_trigger: bool,
    pub max_level: f32,
    pub max_duration_ms: u32,
    /// Minimum gap between the end of one activation and the start of the next.
    pub min_spacing_ms: u32,
    pub max_per_minute: u32,
    /// Reduce over-limit levels/durations to the limit instead of refusing the plan.
    pub clamp: bool,
}

impl OutputLimits {
    /// Safe starting point for physical devices: low ceiling, short bursts, owner-only.
    pub fn physical_default() -> Self {
        OutputLimits {
            enabled: false,
            physical: true,
            electrical: false,
            audience_may_trigger: false,
            max_level: 0.3,
            max_duration_ms: 2_000,
            min_spacing_ms: 1_000,
            max_per_minute: 10,
            clamp: false,
        }
    }
    /// Non-physical outputs (chat, overlays, OSC params): enabled, generous but still bounded.
    pub fn digital_default() -> Self {
        OutputLimits {
            enabled: true,
            physical: false,
            electrical: false,
            audience_may_trigger: true,
            max_level: 1.0,
            max_duration_ms: 60_000,
            min_spacing_ms: 0,
            max_per_minute: 120,
            clamp: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    EmergencyStop,
    UnknownOutput(String),
    Disabled(String),
    AudienceNotAllowed(String),
    LevelTooHigh(String),
    TooLong(String),
    TooClose(String),
    RateLimited(String),
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Rejection::EmergencyStop => write!(f, "emergency stop is active; re-arm to continue"),
            Rejection::UnknownOutput(o) => write!(f, "{o}: not a configured output"),
            Rejection::Disabled(o) => write!(f, "{o}: output is disabled"),
            Rejection::AudienceNotAllowed(o) => write!(f, "{o}: viewers may not trigger this output"),
            Rejection::LevelTooHigh(o) => write!(f, "{o}: level above the owner's limit"),
            Rejection::TooLong(o) => write!(f, "{o}: duration above the owner's limit"),
            Rejection::TooClose(o) => write!(f, "{o}: activations closer together than allowed"),
            Rejection::RateLimited(o) => write!(f, "{o}: too many activations this minute"),
        }
    }
}
impl std::error::Error for Rejection {}

#[derive(Debug, Default)]
pub struct Governor {
    limits: HashMap<String, OutputLimits>,
    stopped: bool,
    /// Start times (absolute ms) of accepted activations per output, last minute only.
    history: HashMap<String, VecDeque<u64>>,
    /// End time (absolute ms) of the last accepted activation per output.
    busy_until: HashMap<String, u64>,
}

const MINUTE: u64 = 60_000;

impl Governor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Owner-only: register or change an output's limits. Electrical outputs must also be physical.
    pub fn configure(&mut self, output: &str, mut limits: OutputLimits) {
        if limits.electrical {
            limits.physical = true;
        }
        limits.max_level = limits.max_level.clamp(0.0, 1.0);
        self.limits.insert(output.to_owned(), limits);
    }

    pub fn limits(&self, output: &str) -> Option<&OutputLimits> {
        self.limits.get(output)
    }

    /// Cancels everything: the caller must also cancel running plans and send `Stop` to devices.
    pub fn emergency_stop(&mut self) {
        self.stopped = true;
    }

    /// Manual re-arm after an emergency stop.
    pub fn rearm(&mut self) {
        self.stopped = false;
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// Check a plan that would start at `now_ms`. On success returns the (possibly clamped) plan and
    /// records it; on failure nothing is recorded.
    pub fn check(&mut self, plan: &Plan, origin: Origin, now_ms: u64) -> Result<Plan, Rejection> {
        let mut out = plan.clone();
        let mut busy = self.busy_until.clone();
        let mut history: HashMap<String, VecDeque<u64>> = HashMap::new();
        for p in &mut out.actions {
            let name = p.action.output.clone();
            if matches!(p.action.command, Command::Stop) {
                continue; // Stopping is always allowed, even after an emergency stop.
            }
            if self.stopped {
                return Err(Rejection::EmergencyStop);
            }
            let limits = self.limits.get(&name).ok_or_else(|| Rejection::UnknownOutput(name.clone()))?;
            if !limits.enabled {
                return Err(Rejection::Disabled(name));
            }
            if origin == Origin::Audience && !limits.audience_may_trigger {
                return Err(Rejection::AudienceNotAllowed(name));
            }
            let start = now_ms.saturating_add(p.at_ms);
            let mut length = 0u64;
            if let Command::Level { level, duration_ms } = &mut p.action.command {
                if *level > limits.max_level {
                    if !limits.clamp {
                        return Err(Rejection::LevelTooHigh(name));
                    }
                    *level = limits.max_level;
                }
                if *duration_ms > limits.max_duration_ms {
                    if !limits.clamp {
                        return Err(Rejection::TooLong(name));
                    }
                    *duration_ms = limits.max_duration_ms;
                }
                length = u64::from(*duration_ms);
            }
            if let Some(&until) = busy.get(&name)
                && start < until.saturating_add(u64::from(limits.min_spacing_ms))
                && limits.min_spacing_ms > 0
            {
                return Err(Rejection::TooClose(name));
            }
            busy.insert(name.clone(), start.saturating_add(length));
            let window = history
                .entry(name.clone())
                .or_insert_with(|| self.history.get(&name).cloned().unwrap_or_default());
            while window.front().is_some_and(|&t| t.saturating_add(MINUTE) <= start) {
                window.pop_front();
            }
            if window.len() >= limits.max_per_minute as usize {
                return Err(Rejection::RateLimited(name));
            }
            window.push_back(start);
        }
        // Commit only once the whole plan passed.
        self.busy_until = busy;
        self.history.extend(history);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;
    use crate::chain::{Action, Command, Plan, Planned};

    fn lvl(out: &str, at: u64, level: f32, ms: u32) -> Planned {
        Planned {
            at_ms: at,
            action: Action {
                output: out.into(),
                command: Command::Level { level, duration_ms: ms },
            },
        }
    }
    fn plan(actions: Vec<Planned>) -> Plan {
        Plan { actions, length_ms: 0 }
    }
    fn haptic() -> OutputLimits {
        OutputLimits {
            enabled: true,
            ..OutputLimits::physical_default()
        }
    }

    #[test]
    fn unknown_and_disabled_outputs_fail_closed() {
        let mut g = Governor::new();
        assert_eq!(
            g.check(&plan(vec![lvl("ghost", 0, 0.1, 10)]), Origin::Owner, 0),
            Err(Rejection::UnknownOutput("ghost".into()))
        );
        g.configure("toy", OutputLimits::physical_default());
        assert_eq!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 10)]), Origin::Owner, 0),
            Err(Rejection::Disabled("toy".into())),
            "physical outputs start disabled"
        );
    }

    #[test]
    fn audience_cannot_reach_physical_outputs_by_default() {
        let mut g = Governor::new();
        g.configure("toy", haptic());
        assert_eq!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 10)]), Origin::Audience, 0),
            Err(Rejection::AudienceNotAllowed("toy".into()))
        );
        assert!(g.check(&plan(vec![lvl("toy", 0, 0.1, 10)]), Origin::Owner, 0).is_ok());
    }

    #[test]
    fn limits_reject_or_clamp() {
        let mut g = Governor::new();
        g.configure("toy", haptic());
        assert_eq!(
            g.check(&plan(vec![lvl("toy", 0, 0.9, 10)]), Origin::Owner, 0),
            Err(Rejection::LevelTooHigh("toy".into()))
        );
        assert_eq!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 60_000)]), Origin::Owner, 0),
            Err(Rejection::TooLong("toy".into()))
        );
        g.configure("toy", OutputLimits { clamp: true, ..haptic() });
        let ok = g.check(&plan(vec![lvl("toy", 0, 0.9, 60_000)]), Origin::Owner, 0).unwrap();
        assert_eq!(
            ok.actions[0].action.command,
            Command::Level {
                level: 0.3,
                duration_ms: 2_000
            }
        );
    }

    #[test]
    fn spacing_and_rate_limits_span_plans() {
        let mut g = Governor::new();
        g.configure("toy", haptic());
        assert_eq!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 500), lvl("toy", 600, 0.1, 500)]), Origin::Owner, 0),
            Err(Rejection::TooClose("toy".into())),
            "within one plan"
        );
        assert!(g.check(&plan(vec![lvl("toy", 0, 0.1, 500)]), Origin::Owner, 0).is_ok());
        assert_eq!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 500)]), Origin::Owner, 1_000),
            Err(Rejection::TooClose("toy".into())),
            "across plans"
        );
        let mut t = 2_000;
        for _ in 0..9 {
            assert!(g.check(&plan(vec![lvl("toy", 0, 0.1, 100)]), Origin::Owner, t).is_ok());
            t += 1_200;
        }
        assert_eq!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 100)]), Origin::Owner, t),
            Err(Rejection::RateLimited("toy".into())),
            "10 per minute"
        );
        assert!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 100)]), Origin::Owner, t + MINUTE).is_ok(),
            "window slides"
        );
    }

    #[test]
    fn rejected_plans_record_nothing() {
        let mut g = Governor::new();
        g.configure("toy", haptic());
        assert!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 100), lvl("toy", 2_000, 0.9, 100)]), Origin::Owner, 0)
                .is_err()
        );
        assert!(
            g.check(&plan(vec![lvl("toy", 0, 0.1, 100)]), Origin::Owner, 0).is_ok(),
            "the failed plan's first action was not recorded"
        );
    }

    #[test]
    fn emergency_stop_blocks_all_but_stop() {
        let mut g = Governor::new();
        g.configure("chat", OutputLimits::digital_default());
        g.emergency_stop();
        let text = Planned {
            at_ms: 0,
            action: Action {
                output: "chat".into(),
                command: Command::Text("hi".into()),
            },
        };
        assert_eq!(g.check(&plan(vec![text.clone()]), Origin::Owner, 0), Err(Rejection::EmergencyStop));
        let stop = Planned {
            at_ms: 0,
            action: Action {
                output: "anything".into(),
                command: Command::Stop,
            },
        };
        assert!(g.check(&plan(vec![stop]), Origin::Audience, 0).is_ok());
        g.rearm();
        assert!(g.check(&plan(vec![text]), Origin::Owner, 0).is_ok());
    }

    #[test]
    fn electrical_implies_physical_and_owner_only() {
        let mut g = Governor::new();
        g.configure(
            "shock",
            OutputLimits {
                enabled: true,
                electrical: true,
                physical: false,
                ..OutputLimits::physical_default()
            },
        );
        assert!(g.limits("shock").unwrap().physical);
        assert_eq!(
            g.check(&plan(vec![lvl("shock", 0, 0.1, 100)]), Origin::Audience, 0),
            Err(Rejection::AudienceNotAllowed("shock".into()))
        );
    }
}
