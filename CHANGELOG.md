# Changelog

BetterYTS by FoulFoxHacks — created by Sammy The Femboy Puppy. Site/API versions; the VRChat
packages and BetterYTS Music have their own changelogs.

## 1.1.1 (proposed, not deployed)

### Security
- **In-world linking:** an activation code now belongs to the world client that asked for it.
  Pool slots are public and numbered, so before this anyone could walk `/vrc/p/0…19999` and read
  pending codes (and send their own playlists into someone else's world) or a delivered library
  and its save key. Other callers now get `"status": "expired"`.
- Rate limits and wrong-key lockouts count an IPv6 caller by its /64, so rotating addresses no
  longer resets them.
- Error logs no longer contain activation codes, OAuth codes, states or tokens, or saved-library
  key halves.
- Server-rendered TikTok linking pages send a strict Content-Security-Policy (no scripts).

### Fixes
- Saved libraries are deleted at exactly 30 days (they lasted until just after).
- In-world video slot redirects aren't cacheable: slots are reused, so a cached redirect could
  play the wrong video.
- The TikTok linking page says when TikTok is in testing (sandbox) and only tester accounts can
  sign in.

### Accuracy
- "Ad-free" now says what it means: ad-free *search results*; YouTube's own player can still show
  ads. "No cookies / no accounts" claims corrected (sign-ins are optional; TikTok linking uses one
  short-lived state cookie).
- README feature status; docs say the linking UI isn't in a released VRChat package yet.
- Search protocol v1 vs linking protocol v2 explained; the "slots last 24 hours" promise removed
  (there's no minimum lifetime).

### Added
- `docs/vrchat-install.md`: beginner world-setup guide.
- Tests that run the real Durable Objects and router on Node's built-in SQLite (63 tests).
- GitHub Actions CI: typecheck, tests, build, front-end syntax, `npm audit`, secret scan.
- Skip-to-content link on every page.

## 1.1.0
- TikTok in-world linking (sandbox), `/terms`, linking v2, OAuth imports, watch-party sync v2,
  plugins, backup, transcripts, OpenAPI. See git history for details.
