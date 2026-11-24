# Monorepo migration: resume plan

Any session, human or AI, should be able to pick this up cold. Work top to bottom and tick boxes as you commit.
Branch: `stream/foundation` (pushed). Background: [audit.md](audit.md). SEO rules: [seo.md](seo.md).

## State as of 2026-11-24

- [x] PearConnect imported into `apps/pearconnect` with full history (git subtree)
- [x] Stream API, queue Durable Object and `/stream` noindex hub (`src/stream/`, `stream/`)
- [x] PearConnect workflows moved to `.github/workflows/pearconnect-*.yml`
- [x] Worker CI green; local tests: Worker 73/73, PearConnect 104/104
- [ ] 3 PearConnect workflows fail **only** on `npm audit` (new axios / qs / undici advisories since 2026-09)

## Steps

### 1. Fix the dependency audit (unblocks the merge)
```powershell
cd E:\Codebase\betteryts\apps\pearconnect; npm audit fix --ignore-scripts; npm test
cd relay; npm audit fix; npm test
cd ..\website; npm audit fix; npm run build
```
If `audit fix` can't resolve something, bump `overrides` in that package.json (root `apps/pearconnect/package.json` already overrides `qs` and `body-parser`). Commit as "PearConnect: dependency audit fixes".

### 2. Merge `stream/foundation` into `main`
Open the PR from `stream/foundation`. Merge once every check is green. Merging does **not** deploy anything.

### 3. Deploy the Worker (owner only)
`npm run deploy` from the repo root. This adds the `StreamSession` Durable Object class. Check `/api/health`, `/stream` (it must send `X-Robots-Tag: noindex`) and `/api/stream/v1`.

### 4. Wire PearConnect Desktop to Stream
In `apps/pearconnect/src/engine.js` and `src/index.js`: when `streamSettings()` (in `src/betteryts-stream.js`) returns settings, pass chat adapters a queue adapter whose `handleRequest` calls `BetterYTSStream.submit()`. Then call `start(() => engine.playerState === 'ready')` for playback. Keep `!np`, `!queue` and `!skip` local. The local queue stays the default. Add tests next to `test/betteryts-stream.test.js`.

### 5. Repoint PearConnect links and releases
28 references point at `github.com/foulfoxhacks/PearConnect-Song-Requests`:
```powershell
cd E:\Codebase\betteryts; git grep -n "PearConnect-Song-Requests" apps/pearconnect
```
Point them at `foulfoxhacks/betteryts`, with tags like `pearconnect-v0.3.0-beta.6`. Publish the next Desktop release from this repo.

### 6. Archive (don't delete) the old repo
Only after steps 2–5 are live: add a README notice pointing to the monorepo, then archive `foulfoxhacks/PearConnect-Song-Requests` on GitHub. Old release downloads keep working.

### 7. Keep separate for now
`betteryts-music` (in-app updater, Play signing) and `betteryts-vrchat` (VCC listing in `foulfoxhacks/vpm`). Move each in with `git subtree add --prefix=apps/<name>` only after its release automation points at this repo. `E:\Codebase\betteryts-music` has local-only files (`app/`, `core/toml.backup.example`, `web.zip`): commit or back them up first.

### Later (owner's outline)
Replace PearConnect Desktop (Electron) with BetterYTS's own desktop client: Windows `.msi` (preferred) or `.exe`, a Linux `.deb` and other packages, with a compatibility layer. PearConnect stays the desktop until then.

## Safe to delete locally now
- `E:\Codebase\PearConnect-Song-Requests`: a clean clone; the same code is in `apps/pearconnect`.
