# Stream Desktop — Phase 2 checklist (autopilot resume point)

Same autopilot rules as [PHASE1.md](PHASE1.md):
- Continue without asking.
- Tick boxes in the same commit as the work.
- Run tests, clippy and the audit before every push.
- Pushing to `main` deploys the Worker; verify the live site after Worker changes.

Design: [desktop-blueprint.md](desktop-blueprint.md) §3.2, §4.1, §7.

Phase 2 goal: requests, gifts and chat from TikTok and Twitch drive the queue and chains, and viewers get replies and overlays.

## Steps

- [x] **Server: request types.** Add `kind: song | video | shoutout` to events and queue entries.
  - Shoutouts are text-only, moderated, and length-capped.
  - Per-kind intake switches in `manage`; the console's Video / Shoutout toggles become live.
  - Tests in `test/stream.test.ts`.
- [ ] **`bys-tiktok`**: TikTok LIVE source over the unofficial WebSocket, read-only (blueprint §4.1).
  - Resolve `@user` or a LIVE URL to a room.
  - Pluggable signer (`None` / `Remote(url)`, off by default, never sends credentials).
  - Webcast protobuf decoding of chat, gift (with combo end), like, follow, share, join and room-user count.
  - Message size and rate caps, reconnect backoff, kill switch, fail-closed status.
  - Identity uses the numeric user ID.
  - Fixtures from recorded frames; fuzz-style tests for the decoder.
- [ ] **`bys-twitch`**: official EventSub WebSocket (follows, subs, cheers, raids, channel points) + IRC over TLS for chat.
  - OAuth device flow with minimal scopes; tokens kept in the keychain.
- [ ] **Source → engine wiring.** Every source builds `bys_core::Event` values and feeds them to the engine:
  - `!sr` / `!np` / `!queue` / `!skip` commands go to the Stream API;
  - gifts, follows and other events go to chains.
- [ ] **Chat replies.** Per platform, templated, rate-limited, toggleable. The TikTok source is read-only, so its replies go to the console and overlay.
- [ ] **Audience counts** (TikTok room users, Twitch viewers) feed Discord presence and the console.
- [ ] **Local overlay server.** Loopback WebSocket with now playing, queue, alerts and goals; per-overlay read-only token. The hosted `/stream/overlay` stays as is.
- [ ] **Compatibility sources:** Streamer.bot and TikFinity local WebSockets, so existing PearConnect setups keep working.
- [ ] **Owner action (can't be automated):** rename or replace the Discord application `1545979656262389900` so presence reads "BetterYTS Stream" instead of the old PearConnect name, then update `bys_discord::CLIENT_ID` if the ID changes.
- [ ] **Docs:** update `desktop-blueprint.md` §9 when Phase 2 is done; start `PHASE3.md` (chain editor UI, variables, OBS, VRChat OSC, local API, YouTube official API).
