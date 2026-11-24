# Stream pages and search indexing

Goal: add the BetterYTS Stream docs, API reference and request page without changing how yts.foulfoxhacks.dev is crawled, indexed or ranked.

## What's in place

| Surface | Path | Protection |
|---|---|---|
| Hub (docs + API + request form) | `/stream` (`stream/index.html`) | `<meta name="robots" content="noindex, nofollow">` and `X-Robots-Tag: noindex, nofollow` via `public/_headers` (`/stream`, `/stream/*`) |
| Overlay | `/stream/overlay` | same, plus `Referrer-Policy: no-referrer`; credential only in the `#fragment` |
| API | `/api/stream/v1/*` | `/api/` is already `Disallow`ed in `robots.txt`; every response sends `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` |

Not touched: `public/sitemap.xml`, `sitemap.html`, `robots.txt`, `llms.txt`, the canonical tags and JSON-LD of existing pages, and the nav and footer of existing pages. No existing page links to `/stream`. Nothing new competes for existing keywords.

One behaviour change to note: before this, `yts.foulfoxhacks.dev/stream` matched the catch-all "search and redirect to the top video for *stream*". Static assets win over the Worker for that path now. Those redirect URLs were never indexable (302 + `noindex`), so search engines see no change.

## Launch checklist (when Stream goes public)

1. Change the hub's robots meta to `index, follow`. Keep `/stream/overlay` noindex for good.
2. Drop the `/stream` rule from `public/_headers`, but keep `/stream/*`. Add `/stream/overlay` explicitly if the wildcard is narrowed.
3. Add `https://yts.foulfoxhacks.dev/stream` to `public/sitemap.xml` and `sitemap.html`.
4. Add a nav link and JSON-LD (`WebAPI` + `TechArticle`) that match `docs.html`.
5. Add a short Stream section to `llms.txt`.
