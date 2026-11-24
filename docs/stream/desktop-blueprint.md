# BetterYTS Stream Desktop — Feature Blueprint

Version 1.0 · 2026-11-24 · Status: approved direction, implementation starting
Code: `apps/stream-desktop/` (Rust workspace) · Server side: `src/stream/` (already live at `/api/stream/v1`)

BetterYTS Stream Desktop is the native client for BetterYTS Stream. It replaces PearConnect Desktop (Electron) and grows into a full live-interaction toolkit: requests, chat sources, automation, overlays, VRChat and hardware outputs. Everything below is **BetterYTS's own design and code**.

Other tools were studied for scope:
- Stream Connector by Vixenlicious: chains, OSC, live input and device routing.
- TikFinity: TikTok events.
- The "QUEUE" DJ dashboard: the live-session layout.

No code, text, names or artwork come from them.

Owner decisions this document follows:
- **Rust, not Electron.** Electron's resource use is the reason.
- **Packages:** Windows `.msi` preferred (plus `.exe`), Linux `.deb`, then AppImage / `.rpm` / Flatpak.
- **PearConnect becomes BetterYTS.** No separate PearConnect product or website going forward.
- **TikTok uses the unofficial TikTok LIVE WebSocket.** It is read-only and isolated as an optional adapter (§4.1).

---

## 1. Product definition

| | |
|---|---|
| What it is | A local-first desktop engine that takes live input from audiences, avatars and the stream, decides what to do with it, and drives outputs: the song queue, players, overlays, OBS, VRChat and devices. |
| Who uses it | Streamers, DJs, VRChat creators, venue hosts. Moderators use the BetterYTS web dashboard rather than the desktop. |
| What it is not | It doesn't replace platform moderation. It never uses a viewer's credentials or scrapes private data. It never sends physical-device commands without the owner's explicit setup (§8). |
| Relationship to the cloud | The **BetterYTS Stream queue** (server) stays the single authority for requests. The desktop is an intake source, a playback destination and an automation engine. Automation works offline; requests need the server. |

## 2. Architecture

```
 SOURCES (adapters, each isolated)            ENGINE (bys-core)                 OUTPUTS (adapters, each isolated)
 ─────────────────────────────────            ─────────────────                 ────────────────────────────────
 TikTok LIVE (unofficial WS, read-only) ─┐                                  ┌─ BetterYTS Stream API (queue, receipts)
 Twitch (EventSub / IRC)                 │    normalize → validate          ├─ Players: BetterYTS, Pear Desktop
 YouTube Live (Data API)                 ├──▶ dedupe → rate-limit  ──▶ ...  ├─ Overlays (local WS + hosted)
 Kick (official API where available)     │    trigger router                ├─ OBS WebSocket v5
 Streamer.bot / TikFinity (compat)       │    chain planner                 ├─ Chat replies (per platform)
 VRChat OSC / OSCQuery (live input)      │    SAFETY GOVERNOR (§8)          ├─ VRChat OSC (params, chatbox)
 Local API (loopback, token)             │    executor (cancellable)        ├─ Haptics: Intiface/Buttplug, OwO,
 Hotkeys, timers, manual buttons        ─┘    state store · audit log       │  GiggleTech, PiShock, DG-LAB
                                                                            └─ Webhooks out (allowlisted)
```

Rules:
- Sources only **produce events**. They never call outputs directly.
- Every output command passes the **safety governor**. There is no bypass, including from the local API.
- Each adapter is its own crate with a narrow trait. One platform breaking (TikTok changes its protocol, say) cannot take down the rest.
- The engine plans every chain into a timed action list first. The plan is checked against the governor before anything runs.
- The UI is a separate layer. Shell: Tauri 2 (system WebView, MSI/deb bundling built in), so the UI stays light and the engine stays pure Rust.

### Workspace layout

```
apps/stream-desktop/
├── Cargo.toml            workspace
├── crates/
│   ├── bys-core/         events, conditions, chains, planner, safety governor, state   ← started
│   ├── bys-osc/          OSC 1.0 codec (own implementation), OSCQuery later           ← started
│   ├── bys-tiktok/       TikTok LIVE WebSocket adapter (read-only)                     Phase 2
│   ├── bys-twitch/ bys-youtube/ bys-kick/ bys-streamerbot/                             Phase 2–3
│   ├── bys-stream-api/   client for /api/stream/v1 (intake + destination)              Phase 1
│   ├── bys-player/       Pear Desktop + BetterYTS player control                       Phase 1
│   ├── bys-obs/ bys-haptics/ bys-vrchat/                                               Phase 3–4
│   ├── bys-store/        SQLite + OS keychain secrets                                   Phase 1
│   └── bys-api/          loopback HTTP API                                              Phase 3
└── app/                  Tauri shell + UI                                               Phase 1
```

## 3. Feature map

Status key: **P0** first release · **P1** next · **P2** later · **R** research (needs a feasibility or policy check before building).

### 3.1 Get Live — the session console (from the dashboard reference)

| Feature | Priority |
|---|---|
| Profile card: name, handle, avatar, venue/location (editable) | P0 |
| Session timer ("live for 02:34:56"); Pause and End Session | P0 |
| Intake toggles per request type: **Song**, **Video**, **Shoutout** | P0 |
| Counters: requests received / accepted / rejected (from the server queue) | P0 |
| **Current Queue** with filters (All / Songs / Videos / Shoutouts): artwork, title, request count, requester, price tag, "Mark as completed" | P0 |
| **Played Requests** with filters (All / Completed / Rejected / Pending) and status badges | P0 |
| Approve / reject / reorder / remove (moderation, audited server-side) | P0 |
| Shoutout requests: text message, moderated, shown on overlay when accepted | P1 |
| Video requests: route to the BetterYTS player / OBS browser source | P1 |
| Earnings: **paid and tipped requests**, through a payment provider's hosted checkout. The app never sees card data. Payouts and refunds happen at the provider. Per-request price, minimums, refund-on-reject rule. | P2 (needs provider choice + legal review) |
| Dashboard, Earnings and Requests history pages | P1 / P2 |

### 3.2 Audience sources

| Source | Method | Priority |
|---|---|---|
| **TikTok LIVE** | Unofficial TikTok LIVE WebSocket, read-only (§4.1) | P0 |
| Twitch | Official EventSub WebSocket + IRC for chat; OAuth device flow | P0 |
| YouTube Live | Official Data API v3 `liveChatMessages`, OAuth, quota-aware polling. Replaces the unofficial `youtube-chat` PearConnect used. | P1 |
| Kick | Official public API / webhooks where available | R |
| Streamer.bot | Local WebSocket client (custom events → chains) | P1 |
| TikFinity | Local WebSocket compatibility (existing PearConnect users) | P1 |
| BetterYTS website / Android | Already through `/api/stream/v1` | done (server) |
| Local API | Loopback HTTP with a per-install token (§5) | P1 |
| Hotkeys, timers, manual buttons, Stream Deck-style panel | Local | P1 |

Every source emits the same normalized event: `chat`, `gift`, `like`, `follow`, `share`, `subscribe`, `cheer`, `raid`, `song_request`, `shoutout_request`, `osc_input`, `timer`, `manual`, `external`.

### 3.3 Automation: Actions and Chains

| Feature | Priority |
|---|---|
| Triggers: any normalized event + filters (platform, user role, gift type/value, keyword, command) | P0 |
| Chains: ordered steps (**output**, **delay**, **branch on condition**, **weighted random**, **repeat N**, **stop**) | P0 |
| Conditions: comparisons on event fields, session state and variables; AND / OR / NOT | P0 |
| Groups, enable/disable, chain library, import/export (signed JSON, schema-versioned) | P1 |
| Cooldowns: global, per chain, per user | P0 |
| Concurrency: per-chain lock, per-output lock, queue vs drop vs replace policy | P0 |
| Variables and counters (persisted), e.g. "gift goal" | P1 |
| Visual editor (node / step list) with dry-run preview of the planned timeline | P1 |
| Plan-then-run: the planner turns a chain into a timed action list that the safety governor checks before anything runs | P0 |

### 3.4 Outputs

| Output | Features | Priority |
|---|---|---|
| BetterYTS Stream queue | submit / approve / complete; receipts back to chat | P0 |
| Players | BetterYTS player, Pear Desktop (existing verified-add logic ported to Rust) | P0 |
| Overlays | Now playing, queue, recent, alerts, goals, shoutout banner; local WebSocket + hosted `/stream/overlay` | P0 |
| Chat replies | Per platform, rate-limited, templated, toggleable | P1 |
| OBS | obs-websocket v5: switch scenes, toggle sources, set text, trigger media | P1 |
| VRChat OSC | Set avatar parameters (bool/int/float), chatbox "now playing", typed and range-checked | P1 |
| VRChat OSCQuery | Discover the current avatar and its parameters; per-avatar saved layouts; avatar-change handling | P2 |
| Haptics | Intiface/Buttplug (vibrate, rotate, oscillate, linear), OwO, GiggleTech, DG-LAB, PiShock, all behind §8 | P2 |
| Webhooks out | Allowlisted URLs only, signed payloads | P2 |

### 3.5 Live input (VRChat contacts and OSC parameters)

| Feature | Priority |
|---|---|
| Watch any incoming OSC parameter: deadzone, scale, normalize, smoothing | P2 |
| Contact inputs (SPS / OGB style contact parameters), with zone include/exclude | P2 |
| Modes: **follow** (output tracks input) and **trigger** (fires on crossing a threshold, re-arms below it) | P2 |
| Response curves (own set): `linear`, `latch` (hold last), `cut` (drop on stop), `ramp` (build over time), `pulse` (rate from movement speed), `turn` (fires on direction change), `ease` (configurable curve) | P2 |

### 3.6 Packaging and platform

| Feature | Priority |
|---|---|
| Windows `.msi` (preferred) + `.exe`; Linux `.deb` | P0 |
| AppImage, `.rpm`, Flatpak; macOS `.dmg` | P2 |
| Compatibility layer: platform-specific code (keychain, global hotkeys, BLE, tray, autostart) behind traits with per-OS implementations | P0 |
| Signed builds (Authenticode, signed `.deb` repo); SHA-256 published with each release | P1 |
| Updater: signed update manifest, user-confirmed install, never silent | P1 |
| Release workflow in this monorepo (draft first, owner publishes), as `pearconnect-release.yml` does | P0 |

## 4. Source adapter notes

### 4.1 TikTok LIVE (unofficial WebSocket)

- **Read-only:** room info, chat, gifts, likes, follows, shares, joins. The adapter never posts, never logs in, and never asks for the user's TikTok password or session cookies.
- **Input:** a `@username` or a LIVE URL. The adapter resolves it to a room and opens the webcast WebSocket. Messages are protobuf; the schemas live in `bys-tiktok` and are kept in a shared copy so protocol changes are a one-place fix.
- **Request signing:** TikTok requires signed connection URLs, and the signer is pluggable:
  - `None`: try without signing (works for some rooms).
  - `Remote(url)`: a signing service the owner picks. Only the room ID and connection parameters are sent, never user credentials. It's off by default and shown in the UI as a third-party dependency.
- **Isolation:** its own crate, its own reconnect backoff, a hard cap on message size and rate, and a kill switch in settings. When TikTok changes the protocol, the adapter fails closed with a clear status and nothing else is affected.
- **Risks, stated in the UI:** this is not an official TikTok API. It may break without notice and may conflict with TikTok's terms; the streamer chooses to enable it. TikFinity stays available as an alternative source.
- **Identity:** limits use TikTok's numeric user ID, never the display nickname, the same rule PearConnect already enforced.

### 4.2 Others

- Twitch and YouTube use official APIs with OAuth. Tokens are kept in the OS keychain (§6) and refreshed automatically. Scopes are the minimum needed (read chat; send chat only if replies are on).
- Streamer.bot and TikFinity are local WebSockets. Loopback only, by default.

## 5. Local API (developer integration)

- Bound to `127.0.0.1` only. A different bind address needs an explicit setting and shows a warning.
- Every call needs `Authorization: Bearer <install token>`. The token is generated at first run, stored in the keychain and can be rotated in Settings.
- Endpoints: `GET /v1/info`, `GET /v1/chains` (list hooks), `POST /v1/chains/{id}/run` (with a JSON context ≤ 8 KiB), `GET /v1/events` (SSE, read-only).
- CORS is off: browsers can't call it from web pages. The `Host` header is checked against loopback names to block DNS rebinding.
- Calls go through the same planner and governor as any other trigger, with their own rate limit.

## 6. Data and secrets

| Data | Where | Protection |
|---|---|---|
| Settings, chains, layouts, history, logs | SQLite `bys.db` in the user data dir | Schema-versioned migrations, automatic backup before migrating, user-only file permissions |
| OAuth tokens, Stream credentials, local API token, device keys | **OS keychain** (Windows Credential Manager, Secret Service on Linux) | Never written to the database, logs, exports or diagnostics |
| Exports and backups | User-chosen file | Secrets excluded. Chain exports carry a schema version and checksum. |
| Logs | Rotating files | Credentials and chat content redacted by default; a "verbose" mode is opt-in and time-limited |

## 7. Security practices (apply to every crate)

- **Threat model** in `apps/stream-desktop/SECURITY.md`. Attackers to plan for: malicious chat or event payloads, a compromised or spoofed local process, a malicious web page probing localhost, a hostile signing service, tampered updates, supply chain.
- Untrusted input is parsed into typed structs with size limits. Nothing is `unwrap()`ed on external data. Fuzz targets for the OSC codec and every protocol parser.
- `#![forbid(unsafe_code)]` in all crates except where a platform API requires it. Those crates carry an audited `unsafe` justification.
- Dependencies stay minimal and pinned. `cargo audit` + `cargo deny` (licenses, advisories, duplicate/banned crates) run in CI, and `Cargo.lock` is committed.
- No telemetry. Network destinations are listed in `docs/network.md` and shown in the app.
- Least privilege: per-adapter enable switches, minimum OAuth scopes, scoped BetterYTS credentials (intake vs destination).
- Every chain run, moderation action and device command goes into an append-only audit log: who or what triggered it, the plan, and what the governor decided.

## 8. Safety governor (physical and disruptive outputs)

The governor applies hard limits that **no chain, API call or viewer can raise**. Only the owner can change them, in Settings, and they persist.

- **Emergency stop:** a global hotkey, a tray action and a UI button. It cancels every running chain and sends explicit stop commands to every device. Running again needs a manual re-arm.
- **Per-output caps:** maximum intensity, maximum duration, minimum spacing between activations, maximum activations per minute. Plans that exceed a cap are **rejected, not silently clamped**, unless the owner chose "clamp" for that output.
- **Shock-type outputs** (PiShock, DG-LAB electrical) are **off by default**. Enabling one needs an explicit confirmation naming the device. It has a low default ceiling and cannot be triggered by viewer events unless the owner turns on a separate "audience may trigger" switch.
- **Consent and age gate:** the haptics section stays hidden until the owner confirms they are an adult and that they control the device.
- A device that disconnects mid-chain is treated as stopped, and the chain doesn't resume it. Every device integration sends an explicit stop at the end of each action.

## 9. Roadmap

| Phase | Scope | Done when |
|---|---|---|
| **0** | Workspace, `bys-core` (events, conditions, chains, planner, governor), `bys-osc` codec, CI (`fmt`, `clippy -D warnings`, tests, `cargo audit`) | Tests green in CI |
| **1** | Tauri shell + **Get Live** console; `bys-stream-api`; Pear Desktop + BetterYTS player destination; `bys-store` + keychain; MSI and deb builds | A streamer runs a session end to end without PearConnect |
| **2** | TikTok (unofficial WS) and Twitch sources; chat replies; overlays; Streamer.bot / TikFinity compatibility | Requests and gifts from TikTok and Twitch drive chains and the queue |
| **3** | Chain editor UI, variables, OBS, VRChat OSC, local API, YouTube official API | Creators automate scenes and avatars without code |
| **4** | OSCQuery, live input, haptics behind the governor, paid requests (provider + legal review) | Opt-in hardware with every safety rule in §8 tested |
| **5** | Signing, updater, AppImage/rpm/Flatpak/macOS, retire PearConnect Desktop | PearConnect users migrated |
