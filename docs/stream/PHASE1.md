# Stream Desktop — Phase 1 checklist (autopilot resume point)

The owner put this project on **autopilot** (2026-11-24): continue without asking, and commit, push to `main` and deploy after each step. Pushing to `main` deploys the Worker automatically.

**Rules:**
- Tick boxes here in the same commit as the work.
- Run tests before every push.
- After every Worker push, check the live `/api/health`.

Blueprint: [desktop-blueprint.md](desktop-blueprint.md) · Code: `apps/stream-desktop/`

## Steps

- [x] Server: moderator `complete` action + session counters (`stats`) in the queue response (`634474c`)
- [ ] `bys-stream-api` crate: typed client for `/api/stream/v1`. The HTTP transport is a trait so tests use a fake. HTTPS only (loopback excepted), response size cap, credentials redacted in `Debug`. Endpoints: create session, public view, queue, moderate, manage, mint/revoke tokens, destination claim/report.
- [ ] `bys-store` crate: settings JSON (atomic write, schema version) + secrets through the OS keychain (`keyring`), with an in-memory secret store for tests. Secrets never go to disk in plain text.
- [ ] `app/` Tauri 2 shell (workspace member). UI is plain HTML/CSS/JS, no framework. CSP locked to self + the BetterYTS API origin.
- [ ] Get Live console UI (BetterYTS branding, not a copy of the reference):
  - profile card + venue;
  - session timer;
  - Song / Video / Shoutout intake toggles, Pause, End Session;
  - counters (received / accepted / rejected / completed);
  - Current Queue with filters and "Mark as completed";
  - Played Requests with status filters;
  - approve / reject.
- [ ] Session connect flow: create a session, or paste an existing code + credential. The credential goes to the keychain.
- [ ] Pear Desktop destination in Rust (`bys-player`): port `apps/pearconnect/src/ytmd.js` + `player-queue.js` (verified queue add, no write retries), driven by destination claim/report.
- [ ] `bys-discord`: Discord Rich Presence over local IPC (named pipe on Windows, Unix socket on Linux). No Discord login or tokens; public application ID only.
  - Shows: live status and session timer, now playing (title, artist, artwork, elapsed), viewer / audience count per platform, queue length and request counters, the last trigger or alert (e.g. "Gift goal reached").
  - Privacy: viewer names are hidden unless the owner enables them; every field can be toggled; presence updates are rate-limited to Discord's 15 s rule.
  - Port of `apps/pearconnect/desktop/discord-presence.js`.
- [ ] Build workflow: `.msi` (Windows) and `.deb` (Ubuntu) through the Tauri bundler, as draft releases tagged `stream-desktop-v*`.
- [ ] Docs: update `desktop-blueprint.md` §9 when Phase 1 is done; start `PHASE2.md` (TikTok unofficial WebSocket source, Twitch).
