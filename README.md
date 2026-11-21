# BetterYTS by FoulFoxHacks

**YouTube search without the junk.** An ad-free YouTube search API, a clean front page, and VRChat-ready search links, all running on one Cloudflare Worker.

BetterYTS by FoulFoxHacks — created by Sammy The Femboy Puppy.

> "Ad-free" means ad-free **search results**: ad slots and promoted videos are removed from what
> BetterYTS returns. Videos still play from YouTube (in YouTube's embedded player on the web, or
> through your VRChat video player), and YouTube may show its own ads there.

```
https://yts.foulfoxhacks.dev/search?q=lofi hip hop
```

Paste that into a VRChat video player and it plays the top result. Open it in a browser and you get the results page.

## Why it's better than u2b.cx

| | u2b.cx | BetterYTS |
|---|---|---|
| Search → redirect for VRChat | ✅ | ✅ (`/search?q=`, `/search?=`, `/search?term`, `/<term>`) |
| Pick the nth result | — | `&n=2` |
| Skip Shorts / upcoming streams | — | ✅ by default |
| Length / date / sort / 4K / live filters | — | `&maxlen=600`, `&upload=week`, `&sort=views`, `&features=4k` |
| Paste a YouTube link as the query | — | Goes straight to that video |
| Ad & promo results stripped | — | ✅ ad slots, promoted videos, Shorts shelves and "People also watched" filler removed |
| JSON API | — | `/api/search`, `/api/video/{id}` and more, CORS-enabled |
| SponsorBlock | — | Segments in the API; auto-skip in the web player |
| DeArrow | — | Community titles & thumbnails |
| Return YouTube Dislike | — | Likes & dislikes in the API and player |
| Web front page | — | Search, filters, autocomplete, infinite scroll, privacy-enhanced player |
| Runs on | A server | Cloudflare's edge, with responses cached per city |

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /search?q=…` | VRChat and other media players get a `302` to the top video. Browsers get the results page. Add `&lucky` to always redirect. |
| `GET /lucky?q=…` (`/go`, `/play`) | Always `302` to the top video |
| `GET /<anything>` | u2b.cx-style shortcut, e.g. `/never gonna give you up` |
| `GET /v/{id}` | `302` to a video by ID |
| `GET /api/search?q=…` | Ad-free JSON results with pagination (`next` → `?page=`) |
| `GET /api/video/{id}` | Details + SponsorBlock + Return YouTube Dislike + DeArrow |
| `GET /api/segments/{id}` | SponsorBlock segments (uses the privacy-preserving hash-prefix API) |
| `GET /api/dislikes/{id}` | Return YouTube Dislike votes |
| `GET /api/branding/{id}` / `?ids=a,b,c` | DeArrow titles and thumbnails |
| `GET /api/suggest?q=…` | Autocomplete (`format=opensearch` for browser search bars) |
| `GET /api/playlist/{id}` | A YouTube playlist's videos, paginated |
| `GET /api/channel/{id or @handle}?tab=videos\|live\|shorts\|playlists` | Channel details and videos |
| `GET /api/rooms/new`, `/api/rooms/{code}`, `WS /api/rooms/{code}/ws` | Watch-party rooms (synced playback, shared queue) |
| `GET /room/{code}` | VRChat players: 302 to what the room is playing now |
| `GET /vrc/search?q=`, `/vrc/p/{slot}`, `/vrc/info` | In-world search for the VRChat packages ([protocol](docs/vrchat-protocol.md)) |
| `GET /vrc/protv.playlist?q=…` or `?list=…` | ProTV playlist file from a search or YouTube playlist |
| `GET /api/transcript/{id}?lang=` | A video's captions as timed lines |
| `GET /api/spotify?url=…`, `/api/match?track=&artist=&duration=` | Read a public Spotify playlist/album; match a song to its YouTube video |
| `GET /vrc/link/start/{service}`, `/vrc/l/{a}`, `/vrc/k/{b}`, `/vrc/forget` | In-world account linking v2 ([protocol](docs/vrchat-protocol.md#linking)) |
| `GET /api/inworld/check`, `POST /api/inworld/complete`, `POST /api/inworld/library` | The site side of linking: check a code, send playlists, view/delete a saved world library |
| `GET /auth/google/*`, `/auth/spotify/*`, `/api/auth/config` | Sign-in brokers (PKCE; tokens are never stored) and which ones are set up |
| `GET /api/ecosystem`, `/api/health`, `/api/openapi.json` | Every project's version, service health + build, the OpenAPI 3.1 spec |
| `GET /app/update.json` | BetterYTS Music's in-app updater manifest (the APK is served next to it) |

Search queries accept operators everywhere (site, API and VRChat URLs): `channel:@name`, `-channel:name`, `-word`, `-shorts`, `shorts:only`, `duration:long`, `sort:date`, `upload:week`, `is:4k`, `after:2026-01-01`. See [/docs#operators](https://yts.foulfoxhacks.dev/docs#operators).

### On the website

- **Library** (stored in your browser): queue with autoplay-next, favorites, watch history, your own playlists with share links and ProTV export.
- **Channel and playlist pages**, ad-free, with "Play all", "Shuffle" and "Add all to queue".
- **Chapters** from the description (or SponsorBlock's community chapters), shown on the timeline and searchable. Optional captions.
- **Watch parties**: everyone sees the same video at the same time (server-scheduled starts, clock sync, drift correction), with a shared queue and a VRChat follow link.
- **Search operators**, **hidden channels and words** (Settings), and a **searchable transcript** in the player.
- **Send to phone / VR**: a QR code that opens the video here at the current time, a short `/v/{id}` link for VRChat, or a watch party VR can follow.
- **Imports**: Spotify playlists (public links, or Sign in with Spotify for private ones and Liked Songs) and your YouTube library (Sign in with Google; the token is revoked straight after).
- **Send music to a VRChat world** (`/inworld/{service}/auth`): enter the world's code, pick playlists; just this visit by default, or saved for 30 days.
- **Plugins** grouped into categories, plus sandboxed **community plugins** (Player and Look only).
- **Backup**: export/import settings, library and plugins; the same file works in the Music app.
- **Privacy**: [/privacy](https://yts.foulfoxhacks.dev/privacy) says what's kept and for how long.

### VRChat packages

The [FoulFoxHacks VCC listing](https://vpm.foulfoxhacks.dev) ships an in-world search panel, a ProTV adapter and editor tools.
Source: [foulfoxhacks/betteryts-vrchat](https://github.com/foulfoxhacks/betteryts-vrchat).

### Captions

YouTube now requires an attestation token for captions and transcripts, which server-side code can't produce. BetterYTS
doesn't fake it: the player can show YouTube's own captions, and chapters are used for in-video search instead.

Redirect options: `n`, `shorts`, `live`, `minlen`, `maxlen`, `sort`, `duration`, `upload`, `features`, `to` (`watch` · `youtu.be` · `embed` · `music`), `hl`, `gl`.
Full reference: [`/docs`](https://yts.foulfoxhacks.dev/docs) (source in [`docs.html`](docs.html)).

### How `/search` tells VRChat from a browser

Browsers send `Sec-Fetch-Dest: document` on page loads. yt-dlp (which VRChat uses), AVPro, Unity and ExoPlayer don't. Requests without that header get the redirect. `&lucky` forces it.

### About "ad block"

- **Search results:** ad slots, promoted videos, sponsored shelves and filler shelves are removed on the server. Every response reports what it removed under `blocked`.
- **VRChat:** VRChat plays the stream that yt-dlp pulls out, so YouTube's video ads never play there.
- **Web player:** the page has no ads or trackers, uses `youtube-nocookie.com`, and SponsorBlock skips in-video sponsor reads. YouTube can still put its own ads inside the embedded player. No web page can block those; use a browser extension like uBlock Origin.

### VRChat note

VRChat only plays links from its trusted list unless **Allow Untrusted URLs** is on (Settings → Comfort & Safety). That applies to every custom search domain, u2b.cx included. If you want a link that works with that setting off, use the player's **Copy for VRChat** button. It gives you a plain `youtube.com` link.

## SEO & crawlability

- Every page has a canonical URL, a description, keywords, author/publisher, Open Graph + Twitter cards (`public/brand/og-image.png`) and Schema.org JSON-LD. The home page declares a `SearchAction`, so search engines can offer a sitelinks search box.
- Search and watch URLs (`/?q=…`, `/?v=…`) are rewritten by the Worker with their own `<title>` and `noindex, follow`, so thin result pages never compete with the home page.
- API responses and redirects send `X-Robots-Tag: noindex`, and so do build assets and icons (see `public/_headers`).
- [`robots.txt`](public/robots.txt) allows search and social crawlers, blocks dedicated AI-training crawlers, and publishes Content Signals (`search=yes, ai-train=no`).
- [`sitemap.xml`](public/sitemap.xml) is for search engines, [`/sitemap`](sitemap.html) is the visual map for people, and [`llms.txt`](public/llms.txt) is a plain-language summary for AI tools.
- [`opensearch.xml`](public/opensearch.xml) lets browsers add BetterYTS as a search engine, with live suggestions.

Brand images (favicons, app icons, OG card) are generated from Sammy's art in `public/brand/`.

## Project layout

```
src/index.ts          Worker: router, redirects, JSON API
src/lib/innertube.ts  YouTube InnerTube client (+ HTML fallback), search-filter protobuf encoder
src/lib/parse.ts      Results parser: walks the response tree and drops ad/promo renderers
src/lib/addons.ts     SponsorBlock, DeArrow, Return YouTube Dislike, autocomplete
src/lib/query.ts      Pulls the search term out of every URL shape
src/lib/operators.ts  Search operators (channel:, -word, -shorts, duration:, after:, …)
src/lib/transcript.ts Captions as timed lines
src/lib/spotify.ts    Spotify embed reader and YouTube match scoring
src/lib/google.ts, spotify-auth.ts  Sign-in brokers (PKCE)
src/lib/ecosystem.ts, openapi.ts    /api/ecosystem and /api/openapi.json
src/rooms/            Watch-party Durable Object and protocol
src/vrc/              In-world search pool, thumbnail sheets, account linking (links*.ts)
index.html, web/      Front page (vanilla JS, no framework): app.js, accounts.js (sign-ins),
                      backup.js, plugins.js (+ public/plugin-sandbox.html), qr.js, room.js
docs.html, ecosystem.html, privacy.html, sitemap.html   Other pages
public/               favicon, _headers (CSP, HSTS, caching), robots.txt, media/ (hero video)
public/app/           update.json for the Music app's updater; the APK is deployed, not committed
cloudflare.config.ts  Worker config (custom domain, vars)
test/                 Unit tests (node --test)
```

## Develop & deploy

Needs Node.js 22.23+ / 24.22+ and the [`cf` CLI](https://developers.cloudflare.com/cf/) (installed as a dev dependency).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run typecheck
npm run deploy     # builds and deploys to yts.foulfoxhacks.dev
```

If `cf` can't reach Cloudflare (IPv6 trouble on some networks), deploy with
`$env:NODE_OPTIONS="--dns-result-order=ipv4first"; npx cf deploy` (PowerShell).

**Releasing BetterYTS Music:** bump the version in `../betteryts-music/android/app/build.gradle.kts`,
run `../betteryts-music/scripts/publish-update.ps1` (builds the sideload APK and Play bundle, writes
`public/app/update.json` and copies the APK into `public/app/`), commit `update.json`, then deploy.
Installed sideloaded apps pick the update up within a few hours.

`npm run deploy` attaches the custom domain `yts.foulfoxhacks.dev` from `cloudflare.config.ts`. The `foulfoxhacks.dev` zone has to be on the same Cloudflare account.

If YouTube ever starts rejecting searches, bump `YT_CLIENT_VERSION` in `cloudflare.config.ts` to the current `INNERTUBE_CLIENT_VERSION` from youtube.com's page source.

## Credits & licenses

- Home background video: [Ceos_Stock](https://pixabay.com/users/ceos_stock-13890949/) on [Pixabay](https://pixabay.com/) (Pixabay Content License).

- Code: MIT © FoulFoxHacks
- [SponsorBlock](https://sponsor.ajay.app) and [DeArrow](https://dearrow.ajay.app) data: CC BY-NC-SA 4.0 (non-commercial, with attribution)
- Dislike estimates: [Return YouTube Dislike](https://returnyoutubedislike.com)
- Not affiliated with YouTube or Google.
