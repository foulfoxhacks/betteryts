# Stream Desktop — Phase 3 checklist (autopilot resume point)

Same rules as [PHASE2.md](PHASE2.md) and [../HANDOFF.md](../HANDOFF.md):
- Short code.
- No new high-risk dependencies: run `tools/osv-check.py` on any lockfile change.
- Tick boxes in the same commit as the work, and push to `main`.

Design: [desktop-blueprint.md](desktop-blueprint.md) §3.3–§3.5, §5, §8.

Phase 3 goal: creators automate scenes, avatars and chat responses without code.

## Steps

- [x] **Chain storage:** `chains.json` (schema 1) next to settings; optional `serde` feature on `bys-core` (core stays dependency-free); load validates size (512 KB), nesting (serde_json limit) and engine rules (IDs, conditions); atomic save; the engine reloads live. Commands `chains_get` / `chains_save` (also used for import).
- [x] **Chain editor UI (simple):** the Automations view lists chains (on/off, delete) and builds "when event [on platform] [amount ≥ N] [cooldown]: show text / wait" chains, with a dry-run timeline preview. Advanced imported chains (branch / random / repeat) are kept as-is and shown read-only. Text is set with `textContent` only. A Rust test parses the editor's exact JSON. Branch / random / repeat editing comes later.
- [x] **Outputs:** `console` (last trigger in the console, Discord and overlay), `twitch.chat` (via the Replies switch and its 1.5 s limit; governor 20/min) and `overlay.alert` (8 s line on the local overlay; governor 60/min). The editor has a where-to-show picker.
- [ ] **OBS:** obs-websocket v5 client on loopback (switch scene, toggle source, set text). Its password goes in the keychain. Check any new crate with OSV first.
- [ ] **VRChat OSC output:** typed avatar parameters and the chatbox via `bys-osc` over UDP to `127.0.0.1:9000`; values range-checked; governor limits per parameter.
- [ ] **Local API** (blueprint §5): loopback HTTP, bearer token from the keychain, Host check, no CORS. Endpoints `GET /v1/info`, `GET /v1/chains`, `POST /v1/chains/{id}/run` (context ≤ 8 KiB). Every run goes through the governor.
- [ ] **YouTube Live (official):** Data API v3 `liveChatMessages`, OAuth device flow, quota-aware polling. Replaces relying on Streamer.bot for YouTube where possible.
- [ ] **Release 0.3.0:** tag `stream-desktop-v0.3.0`; verify the draft's checksums; publish when the owner says so.
- [ ] **Docs:** blueprint §9 Phase 3 ✅; start `PHASE4.md` (OSCQuery, live input, haptics behind the governor, paid requests after legal review).
