# BetterYTS audit and release readiness — 2026-11-21

BetterYTS by FoulFoxHacks — created by Sammy The Femboy Puppy.

Branch: `audit/release-readiness` (from `main` at fd636a7, the commit production runs as build
89cc155 + merge). Nothing on this branch is deployed. `main` is untouched.

## 1. Scope and method

Read: the Worker router (`src/index.ts`), linking (`src/vrc/link*.ts`), the URL pool and
handlers (`src/vrc/pool.ts`, `handlers.ts`), OAuth brokers (`src/lib/google.ts`,
`spotify-auth.ts`, `tiktok.ts`), rooms (`src/rooms/*`), HTTP and caching (`src/lib/http.ts`),
`public/_headers`, plugin sandbox, backup import, `cloudflare.config.ts`, `package.json`, the
OpenAPI spec, README, docs page, privacy policy, and the VRChat packages (`main`, 1.0.1, and the
unreleased `feature/inworld-linking`) against the server.

Ran: the test suite, the typecheck, a production build, `npm audit`, front-end syntax checks,
GitHub Actions CI on the pushed branch, a Chromium check of the TikTok form under the new CSP,
and a read-only accessibility and phone-width check of the live site.

Not done, and why: no VRChat client or Unity testing (needs a Windows VRChat install and Unity
2022.3; the maintainer has to do it); no Quest testing; no load testing; no browser E2E suite
(adding Playwright is a new dependency and needs approval); the web UI (`web/app.js`, 2,700
lines) only got a partial accessibility pass.

## 2. Findings (prioritized)

Status: **Fixed** on this branch (with a test where marked), **Open** (proposed fix), or
**Decision** (needs the maintainer).

### Critical: security and data exposure

| # | Finding | File / evidence | Impact | Fix | Status |
|---|---|---|---|---|---|
| S1 | Link polls readable by anyone | `src/vrc/linking.ts` `linkSlot()` answered any caller; slots are numbered 0…19999 and public | Walking `/vrc/p/N` revealed pending codes (anyone could push their playlists into a stranger's world) and delivered libraries **with their save key** (view or delete for 30 days) | Codes store a keyed hash of the requesting client; other callers get `expired`. Yesterday's salt kept 1 day so it holds across midnight UTC | **Fixed**, tested (`test/links-do.test.ts`) |
| S2 | IPv6 rate-limit and lockout bypass | `src/vrc/links.ts` `who()` hashed the full address | One home or phone usually has a whole /64; rotating addresses reset the 5-wrong-keys lockout and every limit | Callers counted by /64 (`clientNet()`) | **Fixed**, tested |
| S3 | Secrets in error logs | `src/index.ts` logged the full URL on errors: `?code=` (activation and OAuth codes), `state`, tokens | Codes and OAuth values in logs | `redactUrl()` | **Fixed**, tested |
| S4 | Workers invocation logs may record full request URLs | `cloudflare.config.ts` `observability.enabled: true` | If Workers Logs store each request's URL (check in the dashboard), `/vrc/l/{a}`, `/vrc/k/{b}` and `?code=` end up there regardless of S3 | Check the dashboard; then either turn off invocation logs or set a short retention and mention it in /privacy | **Decision** |
| S5 | No CSP on server-rendered TikTok pages | `src/vrc/linking.ts` `html()` | XSS defence in depth only (output is already escaped and URLs are https-checked) | `default-src 'none'`, no scripts, `form-action 'self' https://www.tiktok.com` (Chrome applies form-action to the redirect, checked in Chromium) | **Fixed**, tested |
| S6 | Localhost origins allowed in production | `src/rooms/protocol.ts` `originAllowed()` (deliberate, tested) | A page served from `http://localhost` on a user's machine could drive their rooms and linking POSTs | Allow localhost only when the Worker itself runs on localhost | **Decision** (low) |

Checked and fine: OAuth PKCE (S256 only), state checks (site: sessionStorage + 15 min; TikTok:
DO row + `__Host-` cookie, single use), callbacks only redirect to fixed destinations with
regex-checked values, Google and Spotify tokens never stored, the TikTok token revoked in `finally`,
no secrets in config (CI now scans for this), WebSocket origin check, host keys compared in
constant time, backup import whitelists every field and caps sizes, plugin sandbox (opaque
origin, `default-src 'none'`, message shapes checked; existing tests).

### Functional defects

| # | Finding | File / evidence | Impact | Fix | Status |
|---|---|---|---|---|---|
| F1 | Saved library outlived its advertised expiry | `links.ts` sweep used `created < now - TTL` | Kept up to the next request after `expiresAt` | `<=` | **Fixed**, tested |
| F2 | Pool video redirects cacheable for 60 s | `handlers.ts` `redirect(…, 60)` | A reused slot could replay the previous video in a client that caches | `no-store` | **Fixed**, tested |
| F3 | Protocol promised slots last 24 h | `docs/vrchat-protocol.md`; `pool.ts` reuses oldest-first with no age floor | Under heavy use a world's result can point at another world's video | Doc corrected. Code option: skip slots younger than N minutes when assigning (needs a sizing decision) | Doc **fixed**, code **Open** |
| F4 | Site docs implied in-world linking works in worlds | `docs.html`, README; VRChat 1.0.1 (`main`) has search only | Creators look for a feature that isn't shipped | Status notes added | **Fixed** |

### Integration and compatibility risks

| # | Risk | Where | Note |
|---|---|---|---|
| I1 | YouTube client version is pinned | `YT_CLIENT_VERSION` | HTML fallback exists; upstream errors now proven to surface as errors (tested) |
| I2 | ProTV dependency has no upper bound | VRChat `com.foulfoxhacks.betteryts.protv`: `>=3.0.0-beta.20` | A future ProTV 4 would install and may break. Suggest `^3.0.0-beta.20` (world repo) |
| I3 | Google and Spotify sign-in limited to allowlisted accounts | provider dashboards | Expected while unverified; documented as limited |
| I4 | TikTok in sandbox | `TIKTOK_MODE = "sandbox"` | Left on sandbox. Page now says only testers can sign in |
| I5 | `@cloudflare/vite-plugin` was on the moving `beta` tag | `package.json` | Pinned to the locked `2.0.0-beta.v.17` |
| I6 | Unity/VRChat behaviour unverified here | VRChat packages | See the tested/untested table in `docs/vrchat-install.md` |

### Missing automated tests (remaining)

- Watch-party Room Durable Object over WebSockets (hibernation API): only the protocol functions
  are unit-tested. Next step: extend `test/support/do.ts` with a WebSocket pair double.
- Browser E2E for search, player, library and linking: needs Playwright (new dependency).
- TikTok callback end to end with a mocked TikTok API (helpers are tested; the route isn't).
- Google/Spotify token exchange routes (`/api/auth/google/token`) with a mocked provider.

### UX and accessibility

| Finding | Status |
|---|---|
| No skip link on any page | **Fixed** (checked with the keyboard) |
| Search results view has no visible heading (4 `h1`s across hidden views) | Open: add one visually-hidden `h1` per view |
| Phone: filter row scrolls sideways with no hint (cut-off "Length") | Open: edge fade or "More filters" |
| Live site at 375 px: search works, 20 results, no page-level horizontal scroll, all images have `alt`, all controls named | Checked |
| Player, watch-party and settings keyboard paths; contrast | Not audited |

### Documentation inconsistencies

All **fixed** on this branch: "ad-free" scope; "no cookies / no accounts"; linking status; TikTok
testing; search v1 vs linking v2; slot lifetime; OpenAPI TikTok service; privacy policy now lists
the code-owner hash and the /64 rule; README bindings, secrets, CI and rollback; creator line.

### Performance

- `/api/segments`, `/api/dislikes`, `/api/branding/{id}` set Cache-Control but don't go through
  the edge cache (`cached()`), so every request hits SponsorBlock, RYD or DeArrow. Open: wrap them.
- `web/app.js` is one 2,700-line module. Open: split rarely used views (plugins, backup, linking).

### Lower-priority visual

- Filter row affordance on phones (above); otherwise consistent after the recent polish.

## 3. What changed on this branch

| Commit | What |
|---|---|
| a4d87f3 | S1, S2, F1, privacy policy |
| 28f4387 | S3, S5, F2, TikTok testing note |
| d132d7c | Test harness (real DOs on `node:sqlite`), new DO and route tests, CI, dependency pin |
| 52072ce | Accurate "ad-free", account and cookie claims; creator line |
| 05e15f9 | CSP form-action allows the redirect to TikTok's consent page |
| e789d45 | Install guide, feature status, versions, docs, skip links, 1.1.1 |
| (this) | Changelog and this report |

## 4. Test results (actually run)

| Check | Result |
|---|---|
| `npm test` | **63 passed, 0 failed** (was 45 before; 18 new) |
| `npm run typecheck` | Clean |
| `npm run build` | Succeeds |
| `node --check web/*.js` | All pass |
| `npm audit --omit=dev` | 0 vulnerabilities. Full audit (dev deps) failed locally on a network error; CI runs the runtime audit |
| GitHub Actions CI on `audit/release-readiness` | **Passed** (run 44892639835) |
| TikTok form under new CSP, Chromium | Reaches TikTok's consent page; the old policy was confirmed to block it |
| Live site, 375 px | Search works; no page overflow |

## 5. Release checklist

- [x] Fixes on a branch, `main` untouched
- [x] Tests and CI green
- [ ] Review and merge (PR from `audit/release-readiness`)
- [ ] Decide S4 (log retention) and S6 (localhost origins)
- [ ] Deploy 1.1.1 (`npm run deploy`, IPv4 workaround if needed): **needs your go-ahead**
- [ ] After deploy: `/api/health` shows 1.1.1; start a link from one IP and poll from another
      → `expired`; poll from the same IP → `waiting`
- [ ] VRChat: test the 1.0.1 panel in a Build & Test world on PC (and Quest if you want to claim it)
- [ ] Record a short demo video (search panel in a world, web search, linking once released)

**Version:** site/API 1.1.0 → **1.1.1** (patch: security fixes, no API changes). VRChat packages
stay 1.0.1 (no changes made there). BetterYTS Music stays 0.9.3.

**Deploy requirements:** unchanged bindings and secrets (README › Develop & deploy). No new
secrets. Durable Object change: `VrcLinks` adds a nullable `owner` column to `codes2` on start-up
(`ALTER TABLE`, automatic, backward compatible).

**Compatibility:** worlds poll from the same client that started the code, so the owner check
changes nothing for them. A client whose IP changes during the 10-minute window sees `expired` and
must start a new code (documented). Codes created before the deploy have no owner and keep working
until they expire.

**Rollback:** `cf workers deployments list`, then `cf workers deployments create` back to the
previous version, or redeploy `main`. The added column is ignored by older code.

## 6. Blockers that need a human

1. **Approve the deploy** of 1.1.1 (I haven't deployed).
2. **S4:** check whether Workers Logs keep full URLs, then choose: turn off invocation logs, or
   keep them with short retention and add a line to /privacy.
3. **VRChat testing in Unity and the client** (PC, and Quest if it should be listed), and ALCOM.
4. **Provider approvals:** Google OAuth verification, Spotify extended quota, TikTok app review.
   Until then they stay "limited" or "testing" in the docs. Don't switch `TIKTOK_MODE` to `live`
   before TikTok approves the app and live credentials are set.
5. **World repo** (other session): bound the ProTV dependency (I2), link `docs/vrchat-install.md`
   from its README, and release linking v2 when ready.
6. **Demo video** and independent testers.
