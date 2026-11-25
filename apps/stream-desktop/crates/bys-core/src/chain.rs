//! Chains and the planner. A chain is never executed step by step against live outputs: the
//! planner first expands it (delays, branches, weighted random picks, repeats) into a flat,
//! time-ordered [`Plan`]. The safety governor checks the whole plan before anything runs, so
//! limits apply to what a chain will do, not just to its first step.

use crate::condition::Cond;
use crate::event::{Event, EventKind, Platform, Value};
use std::fmt;

/// What to tell an output.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Physical or level-based outputs (haptics, lights): level 0.0..=1.0 for `duration_ms`.
    Level { level: f32, duration_ms: u32 },
    /// Set a named parameter (VRChat avatar parameter, OBS source, variable).
    Set { name: String, value: Value },
    /// Send text (chat reply, overlay banner, VRChat chatbox).
    Text(String),
    /// Explicit stop. Always allowed, even after an emergency stop.
    Stop,
}

#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, PartialEq)]
pub struct Action {
    /// Output ID as registered with the governor (e.g. "intiface.main", "osc.avatar", "chat.twitch").
    pub output: String,
    pub command: Command,
}

#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Do(Action),
    Delay {
        ms: u32,
    },
    If {
        cond: Cond,
        then: Vec<Step>,
        otherwise: Vec<Step>,
    },
    /// Pick one branch, weighted. Weights of 0 never run.
    Random(Vec<(u32, Vec<Step>)>),
    Repeat {
        times: u32,
        body: Vec<Step>,
    },
    /// End the chain here.
    Stop,
}

/// Which events start a chain.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, PartialEq)]
pub struct Trigger {
    pub kinds: Vec<EventKind>,
    /// Empty = any platform.
    pub platforms: Vec<Platform>,
    pub when: Cond,
}

impl Trigger {
    pub fn matches(&self, ev: &Event) -> bool {
        self.kinds.contains(&ev.kind) && (self.platforms.is_empty() || self.platforms.contains(&ev.platform)) && self.when.eval(ev)
    }
}

#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, PartialEq)]
pub struct Chain {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
    /// Minimum time between two runs of this chain (all users).
    pub cooldown_ms: u64,
    /// Minimum time between two runs caused by the same user.
    pub per_user_cooldown_ms: u64,
}

/// One action at a time offset from the start of the run.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub at_ms: u64,
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Plan {
    pub actions: Vec<Planned>,
    /// When the run ends (last delay or action end).
    pub length_ms: u64,
}

/// Hard ceilings on what a single chain run can expand to.
pub const MAX_ACTIONS: usize = 1000;
pub const MAX_LENGTH_MS: u64 = 10 * 60 * 1000;
pub const MAX_REPEAT: u32 = 100;
pub const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    TooManyActions,
    TooLong,
    TooDeep,
    RepeatTooLarge,
    BadCondition(String),
    BadLevel,
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlanError::TooManyActions => write!(f, "chain expands to more than {MAX_ACTIONS} actions"),
            PlanError::TooLong => write!(f, "chain runs longer than {} minutes", MAX_LENGTH_MS / 60_000),
            PlanError::TooDeep => write!(f, "chain nesting is deeper than {MAX_DEPTH}"),
            PlanError::RepeatTooLarge => write!(f, "repeat count is above {MAX_REPEAT}"),
            PlanError::BadCondition(e) => write!(f, "condition: {e}"),
            PlanError::BadLevel => write!(f, "levels must be between 0 and 1"),
        }
    }
}
impl std::error::Error for PlanError {}

/// Randomness source for weighted picks. Injected so plans are reproducible in tests.
pub trait Rng {
    /// Uniform in `0..bound` (bound > 0).
    fn below(&mut self, bound: u64) -> u64;
}

/// Small non-cryptographic generator (xorshift64*). Fine for picking chain branches; never used for secrets.
#[derive(Debug, Clone)]
pub struct XorShift(u64);

impl XorShift {
    pub fn new(seed: u64) -> Self {
        XorShift(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }
}

impl Rng for XorShift {
    fn below(&mut self, bound: u64) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D) % bound.max(1)
    }
}

struct Planner<'a, R: Rng> {
    event: &'a Event,
    rng: &'a mut R,
    clock: u64,
    out: Vec<Planned>,
    stopped: bool,
}

impl<R: Rng> Planner<'_, R> {
    fn advance(&mut self, ms: u64) -> Result<(), PlanError> {
        self.clock = self.clock.saturating_add(ms);
        if self.clock > MAX_LENGTH_MS { Err(PlanError::TooLong) } else { Ok(()) }
    }

    fn steps(&mut self, steps: &[Step], depth: usize) -> Result<(), PlanError> {
        if depth > MAX_DEPTH {
            return Err(PlanError::TooDeep);
        }
        for step in steps {
            if self.stopped {
                return Ok(());
            }
            match step {
                Step::Do(action) => {
                    if let Command::Level { level, .. } = action.command
                        && !(0.0..=1.0).contains(&level)
                    {
                        return Err(PlanError::BadLevel);
                    }
                    if self.out.len() >= MAX_ACTIONS {
                        return Err(PlanError::TooManyActions);
                    }
                    self.out.push(Planned {
                        at_ms: self.clock,
                        action: action.clone(),
                    });
                    // A level command occupies its output for its duration.
                    if let Command::Level { duration_ms, .. } = action.command {
                        self.advance(u64::from(duration_ms))?;
                    }
                }
                Step::Delay { ms } => self.advance(u64::from(*ms))?,
                Step::If { cond, then, otherwise } => {
                    cond.validate().map_err(PlanError::BadCondition)?;
                    let branch = if cond.eval(self.event) { then } else { otherwise };
                    self.steps(branch, depth + 1)?;
                }
                Step::Random(options) => {
                    let total: u64 = options.iter().map(|(w, _)| u64::from(*w)).sum();
                    if total > 0 {
                        let mut pick = self.rng.below(total);
                        for (weight, body) in options {
                            let w = u64::from(*weight);
                            if pick < w {
                                self.steps(body, depth + 1)?;
                                break;
                            }
                            pick -= w;
                        }
                    }
                }
                Step::Repeat { times, body } => {
                    if *times > MAX_REPEAT {
                        return Err(PlanError::RepeatTooLarge);
                    }
                    for _ in 0..*times {
                        self.steps(body, depth + 1)?;
                    }
                }
                Step::Stop => self.stopped = true,
            }
        }
        Ok(())
    }
}

/// Expand a chain into a bounded, time-ordered plan for one event.
pub fn plan(chain: &Chain, event: &Event, rng: &mut impl Rng) -> Result<Plan, PlanError> {
    chain.trigger.when.validate().map_err(PlanError::BadCondition)?;
    let mut p = Planner {
        event,
        rng,
        clock: 0,
        out: Vec::new(),
        stopped: false,
    };
    p.steps(&chain.steps, 0)?;
    Ok(Plan {
        actions: p.out,
        length_ms: p.clock,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;
    use crate::condition::Operand;
    use crate::event::{RawEvent, Role};

    fn ev(amount: f64) -> Event {
        Event::new(
            Platform::TikTok,
            EventKind::Gift,
            RawEvent {
                id: "g",
                actor: Some(("1", "v", Role::Viewer)),
                amount,
                ..Default::default()
            },
        )
        .unwrap()
    }
    fn level(out: &str, l: f32, ms: u32) -> Step {
        Step::Do(Action {
            output: out.into(),
            command: Command::Level { level: l, duration_ms: ms },
        })
    }
    fn chain(steps: Vec<Step>) -> Chain {
        Chain {
            id: "c".into(),
            name: "c".into(),
            enabled: true,
            trigger: Trigger {
                kinds: vec![EventKind::Gift],
                platforms: vec![],
                when: Cond::Always,
            },
            steps,
            cooldown_ms: 0,
            per_user_cooldown_ms: 0,
        }
    }

    #[test]
    fn delays_levels_and_branches_produce_a_timeline() {
        let big = Cond::Ge(Operand::Field("amount".into()), Operand::Const(Value::Int(100)));
        let c = chain(vec![
            level("a", 0.2, 500),
            Step::Delay { ms: 250 },
            Step::If {
                cond: big,
                then: vec![level("a", 0.8, 1000)],
                otherwise: vec![level("a", 0.4, 100)],
            },
        ]);
        let p = plan(&c, &ev(150.0), &mut XorShift::new(1)).unwrap();
        assert_eq!(p.actions.iter().map(|a| a.at_ms).collect::<Vec<_>>(), vec![0, 750]);
        assert_eq!(p.actions[1].action.command, Command::Level { level: 0.8, duration_ms: 1000 });
        assert_eq!(p.length_ms, 1750);
        let small = plan(&c, &ev(5.0), &mut XorShift::new(1)).unwrap();
        assert_eq!(small.actions[1].action.command, Command::Level { level: 0.4, duration_ms: 100 });
    }

    #[test]
    fn repeat_random_and_stop() {
        let c = chain(vec![
            Step::Repeat {
                times: 3,
                body: vec![Step::Random(vec![(1, vec![level("a", 0.1, 10)]), (0, vec![level("never", 1.0, 10)])])],
            },
            Step::Stop,
            level("after", 0.5, 10),
        ]);
        let p = plan(&c, &ev(1.0), &mut XorShift::new(7)).unwrap();
        assert_eq!(p.actions.len(), 3);
        assert!(p.actions.iter().all(|a| a.action.output == "a"), "zero weight never runs; nothing after Stop");
    }

    #[test]
    fn expansion_bombs_are_refused() {
        let nested = Step::Repeat {
            times: 100,
            body: vec![Step::Repeat {
                times: 100,
                body: vec![level("a", 0.1, 0)],
            }],
        };
        assert_eq!(plan(&chain(vec![nested]), &ev(1.0), &mut XorShift::new(1)), Err(PlanError::TooManyActions));
        assert_eq!(
            plan(&chain(vec![Step::Repeat { times: 101, body: vec![] }]), &ev(1.0), &mut XorShift::new(1)),
            Err(PlanError::RepeatTooLarge)
        );
        assert_eq!(
            plan(&chain(vec![Step::Delay { ms: u32::MAX }]), &ev(1.0), &mut XorShift::new(1)),
            Err(PlanError::TooLong)
        );
        assert_eq!(
            plan(&chain(vec![level("a", 1.5, 10)]), &ev(1.0), &mut XorShift::new(1)),
            Err(PlanError::BadLevel)
        );
        let mut deep = level("a", 0.1, 1);
        for _ in 0..=MAX_DEPTH {
            deep = Step::Repeat { times: 1, body: vec![deep] };
        }
        assert_eq!(plan(&chain(vec![deep]), &ev(1.0), &mut XorShift::new(1)), Err(PlanError::TooDeep));
    }

    #[test]
    fn trigger_filters() {
        let mut t = Trigger {
            kinds: vec![EventKind::Gift],
            platforms: vec![Platform::Twitch],
            when: Cond::Always,
        };
        assert!(!t.matches(&ev(1.0)), "wrong platform");
        t.platforms.clear();
        assert!(t.matches(&ev(1.0)));
    }
}
