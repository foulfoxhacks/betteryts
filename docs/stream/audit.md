# BetterYTS Stream — repository audit and PearConnect parity matrix

Phase 0 of the *BetterYTS Ecosystem Combined Feature Map & Implementation Blueprint* (v1.0, 2026-11-22).
Audited from source on 2026-11-24. Statuses here are verified from code and test runs. They are not plans.

## 1. What exists

| Repository | Stack | Deploys as | Baseline |
|---|---|---|---|
| `foulfoxhacks/betteryts` (this repo, root) | TypeScript Cloudflare Worker, Vite static pages, `cf` CLI; Durable Objects `VrcPool`, `VrcLinks`, `Room` | Worker `betteryts` on `yts.foulfoxhacks.dev` | 63 tests pass, `tsc` clean, build OK |
| `foulfoxhacks/PearConnect-Song-Requests` → **`apps/pearconnect`** | Node ≥22 ESM engine, Electron desktop, Express webhook, `tmi.js`, `youtube-chat`, `ws`; relay Worker (`relay/`, Wrangler) with a `StreamSession` DO; VitePress site (`website/`) | Desktop app (portable Windows build), relay Worker on `pearconnect.mellozone.site/api/session*`, static site | 104 tests pass |
| `foulfoxhacks/betteryts-music` | Rust core + Kotlin/Compose Android | APK/AAB (Play + sideload via `public/app/update.json`) | not merged (see §5) |
| `foulfoxhacks/betteryts-vrchat` | Unity VPM packages (UdonSharp), ProTV adapter, editor tools | VPM listing `foulfoxhacks/vpm` | not merged (see §5) |
| Intersip | separate product | — | out of scope by design |

Local note: the old `E:\Codebase\betteryts` checkout had missing git objects (`bad object HEAD`). `git fetch origin` restored them. It was 1.1.0 and stale. Every change in it had already been merged into `origin/main` (1.1.1), so the new work branches from `origin/main`.

## 2. Answers to the blueprint's "decide during audit" questions

| Question | Finding |
|---|---|
| Is BetterYTS's existing queue suitable for Stream? | BetterYTS has no request queue. `Room` is watch-party playback sync, and the VRChat pool is a URL slot pool. **Stream owns its queue** in a new `StreamSession` DO. Shared queue primitives can be pulled out later, once a second consumer exists. |
| Is Pear Desktop a standalone app, a local service or both? | It's a separate desktop player (a YouTube Music client) with a local HTTP API on `127.0.0.1:26538`, used through the `ytmd-stream-bot` client token (`src/ytmd.js`). PearConnect Desktop is the local service that drives it. |
| Which PearConnect functions need local state or platform libraries? | Pear Desktop control (local HTTP), TikFinity WebSocket (`ws://127.0.0.1:21213`), the Streamer.bot webhook (local Express), Twitch (`tmi.js`), YouTube Live (`youtube-chat`, unofficial and read-only), single-instance lock, Discord presence, Electron UI and overlays. These stay local. |
| Which BetterYTS APIs can be reused internally? | `search()` and `videoDetails()` in `src/lib/innertube.ts`, and `videoIdFromQuery()` in `src/lib/query.ts`. Stream reuses them for server-side media resolution. |
| Which clients need Stream in release 1? | PearConnect Desktop (intake and Pear Desktop playback) and the website request form. Android and VRChat come later (blueprint Release 2–3). |
| Monorepo? | Yes, at the owner's request. Done as a **subtree** with history (§6). Deployables stay separate. |
| Deployment and auth model | BetterYTS: one Worker, public keyless API, DO-backed features with hashed bearer or code credentials. PearConnect relay: owner bearer token (SHA-256 at rest), HttpOnly dashboard cookie, Workers rate-limit bindings. |
| Which connectors are officially supported? | Twitch IRC via `tmi.js` (supported). YouTube Live via `youtube-chat` (unofficial scraping; keep read-only and flagged). TikTok only through TikFinity or Streamer.bot (external bridge). |

## 3. PearConnect parity matrix

| Feature | Current implementation | Dependencies | Data ownership | BetterYTS Stream equivalent | Risk | Acceptance test |
|---|---|---|---|---|---|---|
| `!sr / !np / !queue / !skip` parsing | `src/commands.js` `parseCommand` | — | config | `src/stream/policy.ts` `parseCommand` (same regex and rules) | Low | `test/stream.test.ts` "command syntax" |
| Input validation (length, control chars, `%placeholder%`) | `src/validation.js` | — | — | `contracts.ts` `cleanText` | Low | "canonical event validation" |
| Cooldown, max per user, max duration, unknown-duration refusal, blocklist (query and metadata), request allowlist, YouTube ID-only allowlist, web can't match allowlist | `src/queue-manager.js`, `commands.js` `isAllowed` | — | in-memory maps | `policy.ts` `precheck` / `evaluate` + DO counters (persistent) | Low | "precheck and evaluate…", "allowlists" |
| Quota reserved before the first await | `inFlight` set | — | memory | `resolving` rows count as active (two-phase intake) | Low | DO "intake…" test |
| Rule edits re-checked after the search | `canMutate` / `rules_changed` | — | memory | `settle()` re-runs precheck and evaluate | Low | covered by settle path |
| Song lookup | Pear Desktop search (`findFirstSong`) | Pear Desktop | — | **BetterYTS search / videoDetails** (`resolve.ts`); Pear search stays the local default | Medium (results can differ from YT Music) | "resolve" test; manual comparison TODO |
| Add to Pear queue + verify by queue diff, never retry a write | `queue-manager.js` + `player-queue.js` | Pear Desktop | Pear | `apps/pearconnect/src/betteryts-stream.js` `dispatch()` (same diff and no-retry rule) | Low | `test/betteryts-stream.test.js` |
| Outcome uncertainty | `outcomeUncertain` | — | — | `report({outcomeUncertain})` → `failed` + flag | Low | connector test |
| Request paused / guided verification (`pearcheck-…`) | `engine.js` | — | memory | Intake on/off in DO. Guided verification stays local in Desktop. | Medium | not yet wired |
| Simple (TikFinity WS) / Advanced (Streamer.bot webhook) modes | `platforms/tikfinity*.js`, `engine.js` | TikFinity, Streamer.bot | local | unchanged; forward via `BetterYTSStream.submit()` | Medium | **engine wiring pending** |
| Twitch, YouTube Live intake | `platforms/twitch.js`, `youtube.js` | tmi.js, youtube-chat | local | unchanged; forward via `submit()` | Medium | **engine wiring pending** |
| Website session codes (create/poll/permit/complete, pairing, dashboard cookie) | `relay/src/index.ts`, `src/session-client.js`, website Vue | relay Worker | relay DO | `StreamSession` DO: create/public/requests/receipt + destination claim/report. Website form at `/stream`. Pairing cookie dashboard: **not yet ported** | Medium | route tests; dashboard pending |
| Rate limits (5 creates/min, 6 web requests/min per connection) | relay `ratelimits` + DO table | Workers rate limit | relay | per-IP throttle DO + DO `limits` table | Low | "routes" test |
| Overlays (now playing, queue, ticker, studio) | Electron `desktop/overlay*`, `player/overlay` | Electron | local | local overlays unchanged; hosted read-only `/stream/overlay#CODE.TOKEN` added | Low | DO overlay test |
| Discord presence, Last.fm, artwork | `desktop/discord-presence.js`, `playback.js` | Discord IPC, Last.fm | local | unchanged (local-only) | — | existing PearConnect tests |
| Moderation (approve/reject/remove/reorder/clear, audit) | none (rules only) | — | — | **new**: DO `moderate()` + audit log, scoped moderator tokens | — | DO moderation test |
| Queue capacity, duplicates, manual approval | none | — | — | **new** in policy | — | policy test |

## 4. Known gaps carried forward

- Wire `BetterYTSStream` into `engine.js` and `index.js` so `STREAM_BACKEND=betteryts` routes chat adapters through `submit()` and starts the destination loop. The module and its tests exist; the engine still always uses the local queue.
- Port the paired web dashboard (cookie auth) onto Stream, or build the creator dashboard at `/stream` (blueprint Phase 5).
- Retire the `pearconnect.mellozone.site` relay only after Desktop releases default to Stream and old releases have aged out. Until then both run.
- Pear Desktop search and BetterYTS search can pick different uploads for the same text. Collect real request logs before switching the default.
- No Workers rate-limit binding yet in `cloudflare.config.ts`. The throttle is a DO per client IP. Swap it for `ratelimits` once the `cf` config exposes them.

## 5. Not merged (and why)

`betteryts-music` and `betteryts-vrchat` have release channels tied to their own repositories. The in-app updater points at release assets. The VCC listing at `foulfoxhacks/vpm` reads GitHub releases from `betteryts-vrchat`, and Play signing lives in that repo's CI. Moving them now would break update paths for installed users. They can move in later with `git subtree add --prefix=apps/<name>` once their release automation is updated to the monorepo paths.

## 6. Monorepo layout

```
betteryts/                      Worker (root, unchanged deploy: npm run deploy)
├── src/stream/                 BetterYTS Stream (contracts, policy, resolve, session DO, routes)
├── stream/                     /stream hub + /stream/overlay (noindex preview)
├── apps/pearconnect/           PearConnect (subtree, full history) — desktop, CLI, relay, website
├── docs/stream/                this audit, architecture, SEO plan
└── .github/workflows/          ci.yml (Worker, ignores apps/**), pearconnect-*.yml (path-filtered)
```

PearConnect's full history comes in through the subtree merge commit. View it with `git log <merge-commit>^2`. To pull later upstream fixes: `git subtree pull --prefix=apps/pearconnect https://github.com/foulfoxhacks/PearConnect-Song-Requests.git main`.
