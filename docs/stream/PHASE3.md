# Stream Desktop — Phase 3 checklist (autopilot resume point)

Same rules as [PHASE2.md](PHASE2.md) and [../HANDOFF.md](../HANDOFF.md):
- Short code.
- No new high-risk dependencies: run `tools/osv-check.py` on any lockfile change.
- Tick boxes in the same commit as the work, and push to `main`.

Design: [desktop-blueprint.md](desktop-blueprint.md) §3.3–§3.5, §5, §8.

Phase 3 goal: creators automate scenes, avatars and chat responses without code.

## Steps

- [ ] **Chain storage:** chains saved as schema-versioned JSON (serde on `bys_core` chain types), validated on load with the engine's existing limits, and loaded into `automation::init`. Import/export, with credentials never included.
- [ ] **Chain editor UI:** a step list (trigger, conditions, do / delay / branch / random / repeat), a dry-run preview of the planned timeline, and enable/disable per chain. Text is rendered with `textContent` only.
- [ ] **Outputs:**
  - `console` (done);
  - chat reply (Twitch);
  - overlay alert;
  - each registered with the governor, using digital defaults.
- [ ] **OBS:** obs-websocket v5 client on loopback (switch scene, toggle source, set text). Its password goes in the keychain. Check any new crate with OSV first.
- [ ] **VRChat OSC output:** typed avatar parameters and the chatbox via `bys-osc` over UDP to `127.0.0.1:9000`; values range-checked; governor limits per parameter.
- [ ] **Local API** (blueprint §5): loopback HTTP, bearer token from the keychain, Host check, no CORS. Endpoints `GET /v1/info`, `GET /v1/chains`, `POST /v1/chains/{id}/run` (context ≤ 8 KiB). Every run goes through the governor.
- [ ] **YouTube Live (official):** Data API v3 `liveChatMessages`, OAuth device flow, quota-aware polling. Replaces relying on Streamer.bot for YouTube where possible.
- [ ] **Release 0.3.0:** tag `stream-desktop-v0.3.0`; verify the draft's checksums; publish when the owner says so.
- [ ] **Docs:** blueprint §9 Phase 3 ✅; start `PHASE4.md` (OSCQuery, live input, haptics behind the governor, paid requests after legal review).
