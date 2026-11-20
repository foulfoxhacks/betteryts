// Spotify sign-in broker: consent URL and callback routing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spotifyAuthorizeUrl, spotifyCallbackRedirect, spotifyClientId } from "../src/lib/spotify-auth.ts";

const origin = "https://yts.foulfoxhacks.dev";
const id = "0123456789abcdef0123456789abcdef";

test("spotify auth: config, consent URL and callbacks", () => {
	assert.equal(spotifyClientId({}), null, "off until a client ID is set");
	assert.equal(spotifyClientId({ SPOTIFY_CLIENT_ID: "nope" }), null);
	assert.equal(spotifyClientId({ SPOTIFY_CLIENT_ID: ` ${id} ` }), id);
	const u = new URL(spotifyAuthorizeUrl(origin, id, "web_abcdefghijklmnopqrst", "a".repeat(43)) as string);
	assert.equal(u.origin, "https://accounts.spotify.com");
	assert.equal(u.searchParams.get("redirect_uri"), `${origin}/auth/spotify/callback`);
	assert.equal(u.searchParams.get("code_challenge_method"), "S256");
	assert.match(u.searchParams.get("scope") ?? "", /user-library-read/);
	assert.deepEqual(spotifyAuthorizeUrl(origin, id, "short", "a".repeat(43)), { error: "Missing or invalid state" });

	const web = new URL(spotifyCallbackRedirect(origin, new URLSearchParams({ state: "web_abcdefghijklmnopqrst", code: "AQBxyz_123-abc" })));
	assert.equal(web.origin, origin);
	assert.equal(web.searchParams.get("link"), "spotify");
	assert.equal(web.searchParams.get("code"), "AQBxyz_123-abc");
	assert.match(spotifyCallbackRedirect(origin, new URLSearchParams({ state: "abcdefghijklmnopqrst", code: "AQBxyz_123-abc" })), /^betterytsmusic:\/\/oauth\/spotify\?/);
	const bad = new URL(spotifyCallbackRedirect(origin, new URLSearchParams({ state: "web_abcdefghijklmnopqrst", code: "<script>" })));
	assert.equal(bad.searchParams.get("code"), null);
	assert.equal(bad.searchParams.get("error"), "invalid_response");
});
