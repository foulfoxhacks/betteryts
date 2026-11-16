# BetterYTS by FoulFoxHacks

**YouTube search without the junk.** An ad-free YouTube search API, a clean front page, and VRChat-ready search links, all running on one Cloudflare Worker.

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
| `GET /api/suggest?q=…` | Autocomplete |

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
index.html, web/      Front page (vanilla JS, no framework)
docs.html             API docs page
public/               favicon, _headers (CSP etc.), robots.txt
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

`npm run deploy` attaches the custom domain `yts.foulfoxhacks.dev` from `cloudflare.config.ts`. The `foulfoxhacks.dev` zone has to be on the same Cloudflare account.

If YouTube ever starts rejecting searches, bump `YT_CLIENT_VERSION` in `cloudflare.config.ts` to the current `INNERTUBE_CLIENT_VERSION` from youtube.com's page source.

## Credits & licenses

- Code: MIT © FoulFoxHacks
- [SponsorBlock](https://sponsor.ajay.app) and [DeArrow](https://dearrow.ajay.app) data: CC BY-NC-SA 4.0 (non-commercial, with attribution)
- Dislike estimates: [Return YouTube Dislike](https://returnyoutubedislike.com)
- Not affiliated with YouTube or Google.
