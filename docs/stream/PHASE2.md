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
- [x] **`bys-tiktok` decoder**: own bounded protobuf reader; webcast push frames (gzip, capped against bombs); chat, gift (final streak message only), like, follow, share, join, viewer count, stream end; mapping to `bys_core` events keyed on the numeric user ID; ack frames; fuzz tests.
- [x] **TikTok connection via TikFinity** (owner's choice): loopback-only WebSocket (`bys_tiktok::tikfinity`), port of PearConnect's parser rules (flat or nested identities must agree, numeric IDs). Chat commands become requests; gifts (final streak), likes, follows and shares become triggers; room viewers feed Discord and the console. Chat shapes match recorded fixtures; gift/like/follow/share/viewer fields still need a live TikFinity check.
  - Resolve `@user` or a LIVE URL to a room.
  - Pluggable signer (`None` / `Remote(url)`, off by default, never sends credentials).
  - Webcast protobuf decoding of chat, gift (with combo end), like, follow, share, join and room-user count.
  - Message size and rate caps, reconnect backoff, kill switch, fail-closed status.
  - Identity uses the numeric user ID.
  - Fixtures from recorded frames; fuzz-style tests for the decoder.
- [x] **`bys-twitch` parsing**: IRC chat (IRCv3 tags, roles from badges, cheers, subs, raids), EventSub messages (welcome, keepalive, reconnect pinned to Twitch's host, revocation, notifications for follow / sub / gift / resub / cheer / raid / channel points) with duplicate and replay protection, OAuth device-flow requests and responses with minimal scopes.
- [x] **`bys-twitch` connection** (client ID `5ddaqfcv7ehy3gwuw7va5tadgh5d99`, "BetterYTS Connector", public client): device-flow sign-in from the console, tokens in the keychain with refresh, EventSub + chat supervised with backoff; `!sr` / `!video` / `!shoutout` become Stream requests keyed on the Twitch message ID. Verified live: device code, EventSub welcome, anonymous chat. The signed-in path runs the first time the owner approves at twitch.tv/activate. official EventSub WebSocket (follows, subs, cheers, raids, channel points) + IRC over TLS for chat.
  - OAuth device flow with minimal scopes; tokens kept in the keychain.
- [ ] **Source → engine wiring.** Every source builds `bys_core::Event` values and feeds them to the engine:
  - `!sr` / `!np` / `!queue` / `!skip` commands go to the Stream API;
  - gifts, follows and other events go to chains.
- [x] **Chat replies (Twitch).** Off by default; the console's Replies switch asks for `user:write:chat` only on the next Twitch sign-in. Each request's result is sent via Helix `chat/messages`, at most one every 1.5 s (extras dropped), cleaned and capped at 500 characters. TikFinity stays read-only (results show in the console). Not yet verified live: needs a signed-in Twitch with replies on.
- [x] **Audience counts, Twitch:** viewer count from Helix `streams` once a minute while connected, shown next to the Twitch name in the console and in Discord presence ("N watching").
- [x] **Audience counts, TikTok:** room viewer count from TikFinity `roomUser` events.
- [ ] **Local overlay server.** Loopback WebSocket with now playing, queue, alerts and goals; per-overlay read-only token. The hosted `/stream/overlay` stays as is.
- [ ] **Compatibility sources:** Streamer.bot local WebSocket (TikFinity is done).
- [x] **Owner action: Twitch application.** Done: "BetterYTS Connector", public client.
- [x] **Owner decision: TikTok signing.** Decided 2026-11-25: **TikFinity only**. No third-party signer; the `bys-tiktok` decoder stays for a possible later direct source.
- [ ] **Owner action (can't be automated):** rename or replace the Discord application `1545979656262389900` so presence reads "BetterYTS Stream" instead of the old PearConnect name, then update `bys_discord::CLIENT_ID` if the ID changes.
- [ ] **Docs:** update `desktop-blueprint.md` §9 when Phase 2 is done; start `PHASE3.md` (chain editor UI, variables, OBS, VRChat OSC, local API, YouTube official API).
