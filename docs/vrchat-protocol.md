# BetterYTS in-world protocol (v1)

This is the contract between the BetterYTS server (`yts.foulfoxhacks.dev`) and the
VRChat packages in the FoulFoxHacks VCC listing (`com.foulfoxhacks.betteryts.*`).
Both sides must follow it exactly. Change it only by bumping `v`.

## Why it works this way

Udon cannot build a `VRCUrl` at runtime. A world only has:

1. URLs typed by a player into a `VRCUrlInputField`, and
2. URLs baked into the scene at edit time.

So BetterYTS uses a **URL pool**: the world bakes `N` URLs of the form
`https://yts.foulfoxhacks.dev/vrc/p/{slot}` (slot = `0 … N-1`) at edit time. When the
server answers a search, it assigns a pool slot to every thing the world may need to
load next (each video, the thumbnail sheet, the next page) and tells the world which
slot to use. The world then loads `pool[slot]`.

VRChat limits that shape the design:

| Limit | Value | Consequence |
|---|---|---|
| String downloads | 1 per 5 s, scene-wide (queued) | One JSON per search/page; everything else via slots |
| Image downloads | 1 per 5 s, scene-wide; **no redirects**; max 2048×2048 | Thumbnails come as one sheet image, served directly (not redirected) |
| Video URLs | resolved by yt-dlp, redirects followed | Video slots answer `302` to `youtube.com/watch` |
| Untrusted URLs | custom domains need *Allow Untrusted URLs* | Prefabs must show a hint when downloads fail |

## Constants

| Name | Value |
|---|---|
| Base URL | `https://yts.foulfoxhacks.dev` |
| Pool URL | `{base}/vrc/p/{slot}` |
| Pool size `N` | `20000` (slots `0 … 19999`) |
| Search URL prefix (pre-filled in the input field) | `{base}/vrc/search?q=` |
| Protocol version `v` | `1` |

Slots are assigned on a ring: once all `N` are used, the oldest is reused. A slot stays
valid for at least 24 hours after it was handed out.

## `GET /vrc/search?q={query}` (+ optional `&page={token}`)

The player types their query after the pre-filled prefix in a `VRCUrlInputField`.
The world loads that URL with `VRCStringDownloader`. The response is JSON
(`application/json`, UTF-8), shaped for `VRCJson`:

```json
{
  "v": 1,
  "ok": true,
  "query": "lofi hip hop",
  "count": 12,
  "sheet": { "slot": 4120, "cols": 4, "rows": 3, "cellW": 320, "cellH": 180, "width": 1280, "height": 540 },
  "next": 4121,
  "results": [
    {
      "slot": 4108,
      "id": "jfKfPfyJRdk",
      "title": "lofi hip hop radio 📚 beats to relax/study to",
      "channel": "Lofi Girl",
      "duration": "",
      "views": "8.1K watching",
      "published": "",
      "live": true,
      "cell": 0
    }
  ]
}
```

- `results` has at most `cols × rows` (12) items: videos only (no Shorts, upcoming streams, channels or playlists).
- `results[i].slot`: pool slot that plays this video (`302` to YouTube).
- `results[i].cell`: index of this video's thumbnail in the sheet, row-major from the **top-left**.
- `sheet.slot`: pool slot that returns the thumbnail sheet image (see below). `null` if there are no results.
- `next`: pool slot whose URL returns the next page in this same JSON format, or `null`.
- On failure: `{ "v": 1, "ok": false, "error": "message" }` with HTTP 200 (so Udon can read it).
- Strings are plain text: no HTML entities. Titles may contain any Unicode.

Optional query parameters (append after the query in the input field):
`&live=0`, `&maxlen=600`, `&minlen=60`, `&sort=views|date|rating`, `&upload=hour|today|week|month|year`.

## `GET /vrc/p/{slot}`

| Slot holds | Response |
|---|---|
| a video | `302 Location: https://www.youtube.com/watch?v={id}` |
| a thumbnail sheet | `200 image/jpeg` bytes directly (**not** a redirect: VRChat images can't follow redirects) |
| a next page | `200 application/json` in the `/vrc/search` format, served directly |
| a link poll | `200 application/json`: see [Linking](#linking) |
| unassigned or expired | `404` (`text/plain`) |

## Thumbnail sheet image

- JPEG, `width × height` exactly as given in `sheet` (≤ 2048 × 2048).
- Grid of `cols × rows` cells, each `cellW × cellH` (16:9), row-major from the top-left, no gaps.
- Empty cells are filled with `#130d0a`.
- Udon: use one `VRCImageDownloader` load into a `Texture2D`, then show each cell on a
  `RawImage` with `uvRect = (col/cols, 1 - (row+1)/rows, 1/cols, 1/rows)` (Unity UVs start at the bottom-left).

## `GET /vrc/info`

`{ "v": 1, "poolSize": 20000, "poolUrl": "https://yts.foulfoxhacks.dev/vrc/p/{slot}", "searchPrefix": "https://yts.foulfoxhacks.dev/vrc/search?q=" }`.
Editor tools read this to bake the pool and pre-fill the input field.

## Linking

Linking protocol **v2** (responses carry `"v": 2`). Players can send their own playlists
(YouTube via Google sign-in, Spotify, or their BetterYTS library), or a list of their own public
TikTok videos, into a world. By default
that's **for this visit only**; if they tick "Save for my next visit", the world gets a
two-part key to keep in PlayerData. Everything uses baked URLs. Privacy policy:
https://yts.foulfoxhacks.dev/privacy#vrchat

### Constants to bake

| What | URLs |
|---|---|
| Start buttons | `{base}/vrc/link/start/youtube`, `{base}/vrc/link/start/spotify`, `{base}/vrc/link/start/tiktok` |
| Saved library, step 1 | `{base}/vrc/l/{a}` for `a = 0 … 9999` |
| Saved library, step 2 | `{base}/vrc/k/{b}` for `b = 0 … 9999` |
| Unlink (delete) | `{base}/vrc/forget` |
| Polling | the existing pool `{base}/vrc/p/{slot}` |

All `/vrc/*` linking responses are HTTP 200 JSON, `Cache-Control: no-store`. Errors are
`{ "v": 2, "ok": false, "error": "…" }` (rate limits included), so the world can always read them.

### Link

1. **Link YouTube / Link Spotify / Link TikTok** → load the start URL:
   `{ "v": 2, "ok": true, "service": "youtube", "code": "K7QX-M2PA", "url": "yts.foulfoxhacks.dev/inworld/youtube/auth", "expiresIn": 600, "poll": 4127 }`
2. Show `code` and `url` large, with a countdown.
3. Poll `pool[poll]` every 5 s while the code is shown:
   - `{ "status": "waiting" }`: keep polling. `{ "status": "expired" }`: stop, offer a new code.
   - `{ "v": 2, "ok": true, "status": "linked", "service", "playlists": [{ "name", "tracks": [{ "title", "channel", "slot" }] }], "library": { "a": 7236, "b": 6240 } | null, "expiresAt": <ms> | null }`
4. Play a track by loading `pool[track.slot]` (a `302` to YouTube). TikTok tracks have `slot: null`: see [TikTok](#tiktok).
5. If `library` isn't null, save `a` and `b` (ints) in PlayerData, e.g.
   `betteryts.lib.youtube.a` / `.b`. `null` means "just this visit": save nothing.

### TikTok

`/vrc/link/start/tiktok` answers the same shape, with `"service": "tiktok"` and
`"url": "yts.foulfoxhacks.dev/inworld/tiktok"`. The player enters the code on that page, picks
"just this visit" or "save", and presses **Continue with TikTok**:

1. `POST /tt/start` (the page's form) checks the code, stores a random `state` (10 min, one use)
   and sets it in an `HttpOnly; Secure; SameSite=Lax` cookie, then redirects to
   `https://www.tiktok.com/v2/auth/authorize/` with `client_key`, `response_type=code`,
   `scope=user.info.basic,video.list`, `redirect_uri={base}/tt/callback`, `state` and
   `disable_auto_auth=1` (TikTok's consent page is always shown).
2. `GET /tt/callback` requires the `state` to match both the cookie and the stored value, then
   exchanges the code at `POST https://open.tiktokapis.com/v2/oauth/token/` (form-encoded, with the
   client secret, server side only), reads `GET /v2/user/info/?fields=open_id,display_name,avatar_url`
   and `POST /v2/video/list/?fields=id,title,cover_image_url,duration,embed_link` (20 per page, up
   to 5 pages), **revokes the token** at `POST /v2/oauth/revoke/`, and completes the code. The
   page then shows the display name, avatar and the videos that were sent.
3. The world's poll gets the usual `linked` shape plus `account` (the TikTok display name), and
   one playlist `"My TikTok videos"` of the user's public videos:
   `{ "title", "channel", "slot": null, "id", "embed_link", "cover_image_url", "duration" }`.

TikTok's Display API gives no playable video file, so the world can only **list** these videos
(and show `embed_link`, TikTok's own player). BetterYTS doesn't scrape, download or re-host
TikTok videos. `cover_image_url` is a signed TikTok CDN link that expires after a while.

Stored: nothing from TikTok except the video list and display name, kept exactly like any other
link (deleted with the code, or 30 days if saved; Unlink, `/vrc/forget` and the site's delete
remove it). No TikTok access or refresh token, open_id or avatar is stored. `/api/inworld/complete`
refuses `service: "tiktok"`: only the server's own callback can make a TikTok link.

The Worker needs the secrets `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` (never in the repo);
without them the page says TikTok linking isn't set up. The redirect URI registered with TikTok
must be exactly `https://yts.foulfoxhacks.dev/tt/callback`.

### Next visit

1. Load `{base}/vrc/l/{a}` → `{ "status": "next" }` (it never says whether the key exists).
2. Within 60 s, load `{base}/vrc/k/{b}` → the same `linked` shape with fresh slots and a **new**
   `library` key. Save it straight away. The old key keeps working only until the new one is
   used once, so a world that crashes before saving can recover.
3. `{ "status": "missing" }`: expired (30 days after saving), deleted, or replaced. Clear the
   saved key and offer Link again.

Both steps are per caller (keyed IP hash), so load them back to back from the same client.
After 5 wrong pairs in an hour the caller is locked out for the hour.

### Unlink

Load `{base}/vrc/forget` right after a successful load or link (within 60 s; the server
remembers what this caller last received). `{ "status": "forgotten" }` deletes the library on
the server; `{ "status": "nothing" }` means there was nothing recent to delete. Clear the
PlayerData keys either way. Players can also view, download or delete a library on the site
(`/?view=link#manage`) by entering the key as `AAAA-BBBB`; show it in the world's settings.

### Limits and safety

- Codes: 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (CSPRNG, 40 bits), 10 minutes, one use.
- Keys: two halves of 0…9999 (10⁸ combinations), CSPRNG, rotated on every load, lockout after failed pairs.
- Stored: playlist names and song video IDs, titles, channels. No account names, emails or tokens
  (TikTok links also keep the display name and each video's embed link, cover link and length).
- "Just this visit" data is deleted when the code expires; saved libraries 30 days after saving
  (rotation doesn't extend that).
- Rate limits per caller: 30 codes/hour, 120 key steps/hour, 20 code entries per 10 minutes,
  30 forgets/hour. Callers are identified by HMAC-SHA-256 of the IP with a secret key replaced
  daily, kept 24 hours.
