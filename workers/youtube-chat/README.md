# BetterYTS chat Worker

YouTube live chat as a small JSON API, built on [`@foulfoxhacks/ametherian-youtube-chat`](https://github.com/foulfoxhacks/Ametherian-NodeJS/tree/main/packages/youtube-chat). It runs as its own Worker on `ytchat.foulfoxhacks.dev`, so scraping traffic, YouTube rate limits and breakage never touch yts.foulfoxhacks.dev or how it's indexed. Every response is `noindex`, and `robots.txt` disallows everything.

| Route | Answer |
|---|---|
| `GET /v1/live?target=@handle` (or `UC…` channel ID, or video ID; `&view=top` for Top chat) | `{ videoId, messages, deleted, continuation, clientVersion, pollMs }`. Edge-cached 15 s per target. |
| `GET /v1/chat?continuation=…&clientVersion=…` | `{ messages, deleted, continuation, pollMs, ended }`. Edge-cached 2 s per continuation, so everyone watching one stream shares one upstream request. |
| `GET /health`, `GET /robots.txt` | |

Errors are JSON `{ error: { status, code, message, retryable } }`: 400 bad input, 404 not live, 503 + `Retry-After` when YouTube rate-limits, 502 for other upstream trouble (upstream bodies are never echoed).

Clients wait `pollMs`, then ask `/v1/chat` with the last `continuation`. PearConnect does this in `apps/pearconnect/src/platforms/youtube.js` (`YOUTUBE_CHAT_API` overrides the host).

## Develop and deploy

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run deploy   # cf deploy; or connect this folder as its own Cloudflare Git build (root: workers/youtube-chat)
```

The custom domain `ytchat.foulfoxhacks.dev` is attached on the first deploy (the zone must be on the same Cloudflare account).
