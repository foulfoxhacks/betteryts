# Add BetterYTS search to your VRChat world

A step-by-step guide for world creators who have never used BetterYTS. It covers the released
packages (**1.0.1**): the in-world YouTube search panel, and playing results on ProTV or VRChat's
own video players.

BetterYTS by FoulFoxHacks — created by Sammy The Femboy Puppy.

```
VCC / ALCOM ──adds──▶ 4 packages ──▶ Tools › FoulFoxHacks › Create BetterYTS Search Panel
                                          │
           ┌──────────────────────────────┴───────────────────────────┐
           ▼                                                          ▼
   Search panel (keyboard, 4×3 thumbnail grid)        Your video player (ProTV 3, or VRC
   loads https://yts.foulfoxhacks.dev/vrc/search?q=…   AVPro / Unity Video Player)
   and 20,000 baked …/vrc/p/{slot} URLs ─────────────▶ plays the slot of the result clicked
```

## What you need

| | |
|---|---|
| Unity | 2022.3 (the version VRChat's Creator Companion installs) |
| VRChat Worlds SDK | 3.7.0 or newer (`com.vrchat.worlds`) |
| A world project | Made with VRChat Creator Companion (VCC) or ALCOM |
| A video player | ProTV 3 (recommended, needs ArchiTech's own listing) or a VRC AVPro / Unity Video Player |

## 1. Add the FoulFoxHacks listing

In **VCC**: *Settings › Packages › Add Repository*, paste

```
https://vpm.foulfoxhacks.dev/index.json
```

and press **Add**. Or open <vcc://vpm/addRepo?url=https%3A%2F%2Fvpm.foulfoxhacks.dev%2Findex.json> while VCC is running.
The listing page is <https://vpm.foulfoxhacks.dev>.

**ALCOM**: the same URL under *Settings › Packages › Add repository*. ALCOM reads the same VPM listing
format, but BetterYTS hasn't been tested with ALCOM by us yet: please report problems.

## 2. Add the packages to your project

Open your world project in VCC (*Projects › Manage Project*) and add:

| Package | Needed? | What it does |
|---|---|---|
| **BetterYTS In-World Search** (`com.foulfoxhacks.betteryts`) | Yes | The search panel |
| **FoulFoxHacks Core** (`com.foulfoxhacks.core`) | Added automatically | URL pool, video-player connectors |
| **BetterYTS Editor Tools** (`com.foulfoxhacks.betteryts.editor`) | Recommended | One-click panel setup, link builder, ProTV playlist import |
| **BetterYTS for ProTV** (`com.foulfoxhacks.betteryts.protv`) | Only with ProTV | Plays results on a ProTV 3 TV (respects its sync, queue and lock rules) |

**ProTV users:** BetterYTS for ProTV depends on ProTV (`dev.architech.protv`, 3.0.0-beta.20 or
newer), which comes from ArchiTech's own VPM listing. Add ArchiTech's listing in VCC first (see
ProTV's own install instructions), or VCC will report a missing dependency.

## 3. Put a video player in your scene

- **ProTV**: add a ProTV TV prefab the usual way.
- **Without ProTV**: add a *VRC AVPro Video Player* or *VRC Unity Video Player* (VRChat SDK prefabs).

## 4. Create the search panel

In Unity: **Tools › FoulFoxHacks › Create BetterYTS Search Panel**.

This adds the panel, bakes the 20,000 `https://yts.foulfoxhacks.dev/vrc/p/{slot}` URLs into the URL
pool, and connects the panel to the video player it finds in the scene. Move and scale the panel
where you want it. **Tools › FoulFoxHacks › BetterYTS** opens the settings window (player
connection, link builder, ProTV playlist import).

## 5. Test it

1. *VRChat SDK › Show Control Panel › Build & Test* (or upload to a private world).
2. In VRChat, turn on **Allow Untrusted URLs** (*Settings › Comfort & Safety*). VRChat only loads
   text, images and videos from domains on its trusted list unless this is on, and
   `yts.foulfoxhacks.dev` isn't on that list. **Every player who wants to search needs this on**,
   so say so on a sign next to the panel.
3. Type a search, wait for the thumbnails, click a result: it plays on your player.

## ProTV playlists from a YouTube search or playlist (no panel needed)

Paste a link into a ProTV Playlist's **Remote URL** import:

```
https://yts.foulfoxhacks.dev/vrc/protv.playlist?q=lofi%20hip%20hop&n=50
https://yts.foulfoxhacks.dev/vrc/protv.playlist?list=PLxxxxxxxxxxxxxxxx
```

`n` is how many videos (1–500). The editor window builds these links for you.

## Simple links for any video player

Any VRChat video player (ProTV, USharpVideo, iwaSync, …) can play a search link directly:
`https://yts.foulfoxhacks.dev/search?q=lofi hip hop` plays the top result. Options: `&n=2` (second
result), `&maxlen=600`, `&sort=views`, `&upload=week`. See <https://yts.foulfoxhacks.dev/docs#vrchat>.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| "Turn on Allow Untrusted URLs" or nothing loads | The player has *Allow Untrusted URLs* off. |
| Thumbnails stay blank | Image loading also needs *Allow Untrusted URLs*. VRChat also spaces out downloads, so the sheet can take a few seconds. |
| A result plays the wrong video, or "this slot is empty or expired" | Slots are shared by every BetterYTS world on a ring of 20,000; a very old result can be reused. Search again. |
| "Search failed" / "BetterYTS error 5xx" | YouTube or BetterYTS had a problem. The message comes from the server; try again in a moment. Status: <https://yts.foulfoxhacks.dev/api/health>. |
| VCC: missing dependency `dev.architech.protv` | Add ArchiTech's ProTV listing (step 2), or don't add *BetterYTS for ProTV*. |
| VCC: package not found | Re-add the listing URL; check <https://vpm.foulfoxhacks.dev/index.json> opens in a browser. |

VRChat limits how often a world can load text and images (one download every 5 seconds per
world, queued), so searches and pages aren't instant. That's VRChat's limit,
not a BetterYTS one.

## What's tested, and what isn't

| | Status |
|---|---|
| VCC install, Unity 2022.3, Worlds SDK 3.7+ | Tested by the maintainer (packages 1.0.1 build and compile) |
| PC (Windows) VRChat client | Expected to work; report problems |
| Quest / Android VRChat | **Not tested.** YouTube playback on Android depends on VRChat's own URL handling, not on BetterYTS |
| ALCOM | **Not tested** (same listing format) |
| ProTV | Built against ProTV 3.0.0-beta.20+; newer ProTV versions not yet re-tested |

## Not in the released packages yet

**In-world linking** (players sending their own YouTube, Spotify or TikTok playlists to a world
with an activation code) runs on the server already (protocol: [Linking](vrchat-protocol.md#linking)),
but the world-side UI isn't in a released package yet. It will be listed here when it ships.

## Versions

- Packages: 1.0.1 (all four move together).
- In-world **search** protocol: v1 (`"v": 1` in `/vrc/search` and pool responses).
- In-world **linking** protocol: v2 (`"v": 2` in `/vrc/link/*`, `/vrc/l|k/*`, `/vrc/forget`).
  These are separate numbers for separate parts; see [vrchat-protocol.md](vrchat-protocol.md#versions).
