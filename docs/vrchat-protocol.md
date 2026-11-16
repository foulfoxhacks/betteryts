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
