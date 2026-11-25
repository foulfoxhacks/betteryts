//! Conditions evaluated against an event. Imported chains are untrusted, so [`Cond::validate`]
//! bounds nesting and size before a condition is ever evaluated.

use crate::event::{Event, Role, Value};

/// Something a condition compares.
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
#[derive(Debug, Clone, PartialEq)]
pub enum Operand {
    /// `kind`, `platform`, `text`, `amount`, `actor.id`, `actor.name`, `actor.role` or `field.<name>`.
    Field(String),
    Const(Value),
}

#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "snake_case"))]
#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Always,
    Eq(Operand, Operand),
    Ne(Operand, Operand),
    Gt(Operand, Operand),
    Ge(Operand, Operand),
    Lt(Operand, Operand),
    Le(Operand, Operand),
    /// Case-insensitive substring match on the operand's text form.
    Contains(Operand, String),
    StartsWith(Operand, String),
    And(Vec<Cond>),
    Or(Vec<Cond>),
    Not(Box<Cond>),
}

pub const MAX_DEPTH: usize = 16;
pub const MAX_NODES: usize = 256;

fn role_str(role: Role) -> &'static str {
    match role {
        Role::Viewer => "viewer",
        Role::Subscriber => "subscriber",
        Role::Moderator => "moderator",
        Role::Owner => "owner",
    }
}

fn resolve(op: &Operand, ev: &Event) -> Option<Value> {
    match op {
        Operand::Const(v) => Some(v.clone()),
        Operand::Field(name) => match name.as_str() {
            "kind" => Some(Value::Text(ev.kind.as_str().into())),
            "platform" => Some(Value::Text(ev.platform.as_str().into())),
            "text" => Some(Value::Text(ev.text.clone())),
            "amount" => Some(Value::Float(ev.amount)),
            "actor.id" => ev.actor.as_ref().map(|a| Value::Text(a.id.clone())),
            "actor.name" => ev.actor.as_ref().map(|a| Value::Text(a.name.clone())),
            "actor.role" => ev.actor.as_ref().map(|a| Value::Text(role_str(a.role).into())),
            other => other.strip_prefix("field.").and_then(|k| ev.fields.get(k).cloned()),
        },
    }
}

fn compare(a: &Operand, b: &Operand, ev: &Event) -> Option<std::cmp::Ordering> {
    let (a, b) = (resolve(a, ev)?, resolve(b, ev)?);
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x.partial_cmp(&y),
        _ => match (&a, &b) {
            (Value::Text(x), Value::Text(y)) => Some(x.to_lowercase().cmp(&y.to_lowercase())),
            (Value::Bool(x), Value::Bool(y)) => Some(x.cmp(y)),
            _ => None, // Mismatched types never compare equal or ordered.
        },
    }
}

impl Cond {
    /// Rejects conditions that are too deep or too large to evaluate safely.
    pub fn validate(&self) -> Result<(), String> {
        fn walk(c: &Cond, depth: usize, nodes: &mut usize) -> Result<(), String> {
            *nodes += 1;
            if depth > MAX_DEPTH {
                return Err(format!("condition nesting is deeper than {MAX_DEPTH}"));
            }
            if *nodes > MAX_NODES {
                return Err(format!("condition has more than {MAX_NODES} parts"));
            }
            match c {
                Cond::And(list) | Cond::Or(list) => list.iter().try_for_each(|x| walk(x, depth + 1, nodes)),
                Cond::Not(inner) => walk(inner, depth + 1, nodes),
                _ => Ok(()),
            }
        }
        walk(self, 0, &mut 0)
    }

    /// Evaluates against an event. Missing fields make comparisons false (fail closed).
    pub fn eval(&self, ev: &Event) -> bool {
        use std::cmp::Ordering::*;
        match self {
            Cond::Always => true,
            Cond::Eq(a, b) => compare(a, b, ev) == Some(Equal),
            Cond::Ne(a, b) => matches!(compare(a, b, ev), Some(Less | Greater)),
            Cond::Gt(a, b) => compare(a, b, ev) == Some(Greater),
            Cond::Ge(a, b) => matches!(compare(a, b, ev), Some(Greater | Equal)),
            Cond::Lt(a, b) => compare(a, b, ev) == Some(Less),
            Cond::Le(a, b) => matches!(compare(a, b, ev), Some(Less | Equal)),
            Cond::Contains(a, needle) => resolve(a, ev).is_some_and(|v| v.to_string().to_lowercase().contains(&needle.to_lowercase())),
            Cond::StartsWith(a, prefix) => resolve(a, ev).is_some_and(|v| v.to_string().to_lowercase().starts_with(&prefix.to_lowercase())),
            Cond::And(list) => list.iter().all(|c| c.eval(ev)),
            Cond::Or(list) => list.iter().any(|c| c.eval(ev)),
            Cond::Not(inner) => !inner.eval(ev),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::event::{EventKind, Platform, RawEvent};

    fn gift(amount: f64, name: &str) -> Event {
        Event::new(
            Platform::TikTok,
            EventKind::Gift,
            RawEvent {
                id: "g1",
                actor: Some(("42", "Fox", Role::Subscriber)),
                text: "",
                amount,
                fields: vec![("gift", Value::Text(name.into()))],
            },
        )
        .unwrap()
    }
    fn f(name: &str) -> Operand {
        Operand::Field(name.into())
    }
    fn k(v: Value) -> Operand {
        Operand::Const(v)
    }

    #[test]
    fn comparisons_and_logic() {
        let e = gift(100.0, "Rose");
        assert!(Cond::Ge(f("amount"), k(Value::Int(100))).eval(&e));
        assert!(!Cond::Gt(f("amount"), k(Value::Int(100))).eval(&e));
        assert!(
            Cond::Eq(f("field.gift"), k(Value::Text("rose".into()))).eval(&e),
            "text compare is case-insensitive"
        );
        assert!(Cond::Eq(f("actor.role"), k(Value::Text("subscriber".into()))).eval(&e));
        assert!(
            Cond::And(vec![
                Cond::Eq(f("kind"), k(Value::Text("gift".into()))),
                Cond::Not(Box::new(Cond::Eq(f("platform"), k(Value::Text("twitch".into())))))
            ])
            .eval(&e)
        );
        assert!(Cond::Contains(f("field.gift"), "OS".into()).eval(&e));
    }

    #[test]
    fn missing_or_mismatched_fails_closed() {
        let e = gift(1.0, "Rose");
        assert!(!Cond::Eq(f("field.nope"), k(Value::Int(1))).eval(&e));
        assert!(!Cond::Ne(f("field.nope"), k(Value::Int(1))).eval(&e), "unknown is neither equal nor unequal");
        assert!(!Cond::Eq(f("field.gift"), k(Value::Int(1))).eval(&e));
    }

    #[test]
    fn deep_or_huge_conditions_are_refused() {
        let mut c = Cond::Always;
        for _ in 0..=MAX_DEPTH {
            c = Cond::Not(Box::new(c));
        }
        assert!(c.validate().is_err());
        assert!(Cond::Or(vec![Cond::Always; MAX_NODES + 1]).validate().is_err());
        assert!(Cond::And(vec![Cond::Always; 10]).validate().is_ok());
    }
}
