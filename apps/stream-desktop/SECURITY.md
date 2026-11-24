# BetterYTS Stream Desktop — security notes

Design: [docs/stream/desktop-blueprint.md](../../docs/stream/desktop-blueprint.md) §5–§8.

## Threat model (who we defend against)

| Threat | Main defences |
|---|---|
| Hostile chat / gift / OSC payloads | `Event::new` and `bys_osc::decode` validate size, type and content; malformed input is an error, never a panic |
| Chain "bombs" in imported chains | Planner caps: 1000 actions, 10 minutes, repeat ≤ 100, nesting ≤ 16; conditions ≤ 256 parts |
| Viewers driving physical devices | Safety governor: physical outputs start disabled and owner-only; electrical outputs owner-only; caps on level, duration, spacing and rate; emergency stop |
| A web page probing localhost | Local API binds to loopback, needs a bearer token, no CORS, Host header check (Phase 3) |
| A malicious local process | Same token requirement; secrets only in the OS keychain |
| TikTok's unofficial protocol changes or a hostile signing service | Isolated adapter, fails closed, sends no credentials, off by default |
| Tampered updates and dependencies | Signed releases with published SHA-256, `Cargo.lock` committed, `cargo audit` in CI, minimal dependencies |

## Baseline rules for every crate

- `unsafe_code = "forbid"` and clippy `unwrap_used` / `expect_used` / `panic` denied (workspace lints). Tests are exempt.
- New dependencies need a reason in the PR description. Core crates (`bys-core`, `bys-osc`) have none.
- Credentials, chat text and device commands never go into logs unredacted.

## Reporting

Open an issue at https://github.com/foulfoxhacks/betteryts/issues without exploit details, and ask for a private contact.
