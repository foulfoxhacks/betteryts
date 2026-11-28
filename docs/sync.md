# BetterYTS Sync — end-to-end encrypted library sync

Implementations: `web/sync.js` (website) and `core/src/sync.rs` in
[betteryts-music](https://github.com/foulfoxhacks/betteryts-music) (Android, desktop). Both are
tested against the same fixed vectors, and the website's tests decrypt a ciphertext made by the app.
Server: `src/sync/` (one `SyncVault` Durable Object per vault).

## Keys
- **Sync code**: `BTS1-` + 32 random bytes in Crockford base32 (52 characters, groups of four).
  It is the only secret and never leaves the user's devices.
- From the key `k` (lower-case hex), with SHA-256:
  - vault ID = first 32 hex characters of `SHA-256("betteryts-sync:id:" + k)`
  - auth secret = hex `SHA-256("betteryts-sync:auth:" + k)` (the server stores only its SHA-256)
  - encryption key = raw `SHA-256("betteryts-sync:enc:" + k)` → AES-256-GCM, random 12-byte IV,
    associated data = the vault ID.

## API (`/api/sync/{vaultId}`, `Authorization: Bearer <auth secret>`, never cached)
| Method | Body | Result |
|---|---|---|
| GET | | `{ ok, data: { version, updatedAt, iv, data } }` or 404 |
| PUT | `{ iv, data, baseVersion }` | `{ ok, data: { version, updatedAt } }`; 409 `CONFLICT` with the current version if `baseVersion` is stale |
| DELETE | | erases the vault |

The first PUT claims the vault for that auth secret; others get 403. Limits: 3 MB of base64
ciphertext, 120 writes per hour per vault; vaults idle for a year are deleted. Browsers may only
call it from this site (no CORS).

## Payload (inside the ciphertext)
`{ "format": "betteryts-sync", "version": 1, "backup": <betteryts-backup v1>, "ledger": { key: [at, hash|null] } }`

Ledger keys: `f:<videoId>` liked, `c:<channelId>` subscription, `d:<videoId>` disliked,
`p:<playlistId>` playlist (hash = FNV-1a 32 of `name + "\n" + item ids joined by ","`),
`s:<lower-case name>` smart playlist (hash of the rule's fields in a fixed order), `settings`
(hash of `hiddenChannels|hiddenWords|skip categories that are true, sorted`). `hash = null` means
removed; removals are forgotten after 180 days.

## Sync round
1. Compare the current library with the snapshot from the last sync; record changed keys in the
   ledger with the current time (removed keys with `null`).
2. GET the vault (404 = empty), decrypt, merge ledgers: per key the newest entry wins (ties: present
   beats removed, then the larger hash).
3. Rebuild favorites, subscriptions, dislikes, playlists, smart playlists and hidden lists from the
   winners (values come from whichever side has that hash); history is the union of both, newest
   first, 300 entries. The queue isn't synced.
4. If the ledger differs from the vault's, encrypt and PUT with `baseVersion`; on 409, go to 2.
5. Save the new snapshot and ledger; apply the merged library locally.
