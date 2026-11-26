# BetterYTS — agent handoff

Last updated 2026-11-26. Read this file first, then the linked checklists. It's written for an agent picking up the work cold.

## Owner rules (always apply)

- **Autopilot:** continue without asking. Commit, push to `main` and deploy after each step.
  - Every push to `main` deploys the Worker (Cloudflare Git build). Run the tests before pushing, then confirm `https://yts.foulfoxhacks.dev/api/health` shows the new commit.
- **Code:** short code; no long or unnecessary code. Original code only: other products (Stream Connector, TikFinity, the QUEUE dashboard) are references for scope, never sources of code or text.
- **Dependencies:** no vulnerable or high-risk dependencies. Keep them minimal and justify each one. Check them with `python -I tools/osv-check.py` (OSV.dev: GitHub advisories, RustSec, npm, NVD CVE links), `cargo audit` and `npm audit`. Unfixable notices go into `ACCEPTED` in that script, each with a reason.
- **Secrets:** never in files, logs, commits or messages. App credentials live in the OS keychain; Worker secrets are set by the owner.
- **Cloudflare:** this repo has `cloudflare.config.ts`, so use the `cf` CLI, not Wrangler.
- **SEO:** don't change how yts.foulfoxhacks.dev is indexed. `/stream*` is noindex and isn't in the sitemap until launch (`docs/stream/seo.md`).
- **Products:** PearConnect is becoming BetterYTS. Never redeploy pearconnect.mellozone.site; its old GitHub repo was deleted.
- **Desktop client:** Rust (Tauri 2), not Electron. Packages: `.msi` (preferred), `.exe`, `.deb`.
- **TikTok:** through **TikFinity only** (owner decision, 2026-11-25), read-only, loopback. Never use TikTok logins or cookies.

## Repo map (`E:\Codebase\betteryts`, GitHub `foulfoxhacks/betteryts`)

| Path | What |
|---|---|
| `src/` | Worker: YouTube search API, VRChat endpoints, rooms; `src/stream/` = **BetterYTS Stream** API `/api/stream/v1` (queue Durable Object `StreamSession`) |
| `stream/`, `web/stream*.js` | `/stream` hub (docs + API + request form) and `/stream/overlay`, noindex |
| `apps/stream-desktop/` | **Native desktop client** (Rust workspace): `app/` (Tauri) and `crates/` (`bys-core`, `bys-osc`, `bys-stream-api`, `bys-store`, `bys-player`, `bys-discord`, `bys-tiktok`, `bys-twitch`) |
| `apps/pearconnect/` | Legacy PearConnect (Node/Electron), imported with history; still works, with an optional Stream backend |
| `docs/stream/` | `desktop-blueprint.md` (design), `PHASE1.md` ✅, `PHASE2.md` (current), `MIGRATION.md` ✅, `audit.md`, `seo.md` |
| `tools/osv-check.py` | Dependency advisory check (CI: `osv-check.yml`) |
| `.github/workflows/` | `ci.yml` (Worker), `stream-desktop-ci.yml`, `stream-desktop-release.yml` (tag `stream-desktop-v*` → draft release), `pearconnect-*.yml`, `osv-check.yml` |

**Checks:**
- Worker: `npm test`, `npx tsc`.
- Desktop: `cd apps/stream-desktop && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`.
- PearConnect: `cd apps/pearconnect && npm test`.
- Live tests are `#[ignore]` and run with `cargo test -p <crate> -- --ignored live`.

## Completed

1. **Monorepo:** PearConnect imported with history; migration steps 1–6 done (`docs/stream/MIGRATION.md`).
2. **Stream server, live:**
   - requests with policy: cooldown, per-user limit, duration, block/allow lists, duplicates, queue capacity, manual approval;
   - request kinds song / video / shoutout, with a per-kind switch under the master Pause switch;
   - moderation with an audit log, scoped tokens (owner, moderator, intake, destination, overlay), session counters;
   - destination claim/report without redelivery, read-only overlay;
   - security: header-only overlay token, per-network (/64) rate limits, bounded request bodies.
3. **SEO fix, live:** unknown paths no longer redirect browsers or crawlers to YouTube; only media players are redirected.
4. **Desktop Phase 1 ✅** (`PHASE1.md`):
   - Get Live console, OS keychain, Pear Desktop playback with verified adds, Discord Rich Presence;
   - `.msi` / `.exe` / `.deb` release workflow; draft release `stream-desktop-v0.1.0` (unpublished).
5. **PearConnect 0.3.0-beta.6** published from the monorepo (pre-release).
6. **Phase 2 so far:**
   - request kinds;
   - TikTok decoder (fuzz-tested, gzip-bomb safe);
   - Twitch: parsing plus live connection. Client ID `5ddaqfcv7ehy3gwuw7va5tadgh5d99` ("BetterYTS Connector", public client). Device-flow sign-in from the console; `!sr` / `!video` / `!shoutout` become requests.
     - Verified live without signing in: device code, EventSub welcome, anonymous chat.
     - The signed-in path is not verified until the owner approves once at twitch.tv/activate.
7. **Indexing audit (2026-11-26):** the root cause of the drop was the old catch-all that 302'd every unknown path (and `/search?q=` for crawlers) to YouTube, which reads as an open/sneaky redirect (fixed 2026-11-24, item 3). Also fixed: `/llms.html` and `/robots.html` were canonical and in the sitemap but 307 to `/llms` and `/robots`; `workersDev: false`; non-canonical hosts get `noindex`; `npm run check:sitemap` now rejects canonicals that aren't the served route. Owner: request reindexing in Search Console and check Manual actions / Security issues.
8. **PearConnect dependencies (2026-11-26):** express → `node:http` + `@foulfoxhacks/ametherian-schema` (`parseJson`), dotenv → `process.loadEnvFile` / `util.parseEnv`, tmi.js → built-in IRC-over-WebSocket client on `ws`. Ametherian packages are installed from the `v0.1.0-build.8` GitHub release tarballs (integrity pinned in the lockfile, checked against `SHA256SUMS`). Left: `youtube-chat` (unofficial, pulls axios).
9. **YouTube chat scraper (2026-11-26, pending merge/deploy):** new Ametherian package `@foulfoxhacks/ametherian-youtube-chat` ([Ametherian PR #29](https://github.com/foulfoxhacks/Ametherian-NodeJS/pull/29)); separate Worker `workers/youtube-chat` (`betteryts-youtube-chat`, `ytchat.foulfoxhacks.dev`); PearConnect's YouTube adapter uses that Worker and `youtube-chat` (axios) is removed. Remaining steps, in order: merge PR #29 → pin the new release tarball in `workers/youtube-chat/package.json` and commit its lockfile → add the Worker to `tools/osv-check.py` and CI → deploy the Worker → merge to `main`. Not yet verified against live YouTube polling.
10. **Dependency check:** 972 locked versions checked against OSV. npm is clean; the 6 Rust notices are reviewed and accepted with reasons.

## Next (in order)

Phase 2 is done. Continue with [docs/stream/PHASE3.md](stream/PHASE3.md):
1. Chain storage
2. Chain editor UI
3. Outputs
4. OBS
5. VRChat OSC
6. Local API
7. YouTube official API
8. Release 0.3.0

## Waiting on the owner

- ~~TikTok signing~~: decided, TikFinity only. Its source is built; gift / like / follow / share fields still need checking against a live TikFinity.
- **Discord application `1545979656262389900`:** rename it so presence reads "BetterYTS Stream", or create a new one and update `bys_discord::CLIENT_ID`.
- **Publish decisions:** `stream-desktop-v0.2.0` is **published** as a pre-release (2026-11-25, downloads verified against their SHA-256). `stream-desktop-v0.1.0` is still a draft (superseded). Builds are unsigned until code signing is set up. The next tag (0.3.0) adds the local overlay.

## Other projects (not in this repo)

- **Ametherian** (`E:\Codebase\Ametherian-NodeJS`, `foulfoxhacks/Ametherian-NodeJS`): PR #19 is merged (`b0bd10a`), and so is PR #20, the translations in 8 languages (`76e9978`, all checks green). The live site serves a sitemap index with 8 language sitemaps (98 URLs, all returning 200), and the English canonicals are unchanged. Nothing is pending.
- **Midnight Cabin** (a VRChat world, a Unity project under VRChat Creator Companion): an optimization audit runs in its own session and writes `OPTIMIZATION.md` in that project.
