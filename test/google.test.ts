// Google sign-in broker: where the callback sends people.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callbackRedirect } from "../src/lib/google.ts";

test("google: web states return to the site, others to the app", () => {
	const origin = "https://yts.foulfoxhacks.dev";
	const web = new URL(callbackRedirect(origin, new URLSearchParams({ state: "web_abcdefghijklmnopqrst", code: "4/0AbcDEFghijk" })));
	assert.equal(web.origin, origin);
	assert.equal(web.searchParams.get("link"), "google");
	assert.equal(web.searchParams.get("code"), "4/0AbcDEFghijk");
	assert.equal(web.searchParams.get("state"), "web_abcdefghijklmnopqrst");
	assert.match(callbackRedirect(origin, new URLSearchParams({ state: "abcdefghijklmnopqrst", code: "4/0AbcDEFghijk" })), /^betterytsmusic:\/\/oauth\?/);
	const denied = new URL(callbackRedirect(origin, new URLSearchParams({ state: "web_abcdefghijklmnopqrst", error: "access_denied" })));
	assert.equal(denied.searchParams.get("error"), "access_denied");
	const junk = new URL(callbackRedirect(origin, new URLSearchParams({ state: "web_abcdefghijklmnopqrst", code: "bad code with spaces" })));
	assert.equal(junk.searchParams.get("code"), null, "malformed codes aren't passed on");
	assert.equal(junk.origin, origin, "never anywhere but this site");
});
