// In-world linking: codes and library checks (the Durable Object flow is exercised in dev).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLibrary, newCode, normalizeCode, renderLibrary } from "../src/vrc/links-core.ts";

test("links: activation codes", () => {
	const seen = new Set<string>();
	for (let i = 0; i < 2000; i++) {
		const c = newCode();
		assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
		seen.add(c);
	}
	assert.equal(seen.size, 2000, "no repeats in 2000 codes");
	assert.equal(normalizeCode(" k7qx m2pa "), "K7QX-M2PA", "forgiving input");
	assert.equal(normalizeCode("K7QXM2PA"), "K7QX-M2PA");
	assert.equal(normalizeCode("K7QX-M2P0"), null, "0 isn't in the alphabet");
	assert.equal(normalizeCode("K7QX"), null);
	assert.equal(normalizeCode(42), null);
});

test("links: libraries are checked and rendered with slots", () => {
	const lib = cleanLibrary(
		{
			account: "Sammy\u0007",
			playlists: [
				{ name: "Road trip", tracks: [{ id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", channel: "Rick Astley" }, { id: "bad", title: "x" }] },
				{ name: "Empty", tracks: [] },
				{ name: "x".repeat(200), tracks: Array.from({ length: 300 }, () => ({ id: "jNQXAC9IVRw", title: "zoo" })) },
			],
		},
		"youtube",
	);
	assert.equal(lib.account, "Sammy");
	assert.equal(lib.playlists.length, 2, "empty playlists are dropped");
	assert.equal(lib.playlists[0].tracks.length, 1, "bad IDs are dropped");
	assert.equal(lib.playlists[1].tracks.length, 200, "per-playlist cap");
	assert.equal(lib.playlists[1].name.length, 60);
	assert.throws(() => cleanLibrary({ playlists: [] }, "youtube"), /Nothing to send/);
	assert.throws(() => cleanLibrary(null, "youtube"), /Expected/);

	const view = renderLibrary(lib, Array.from({ length: 201 }, (_, i) => 1000 + i), 42);
	assert.equal(view.library, 42);
	assert.equal(view.playlists[0].tracks[0].slot, 1000);
	assert.equal(view.playlists[1].tracks[0].slot, 1001);
	assert.ok(!JSON.stringify(view).includes("dQw4w9WgXcQ"), "the world gets slots, not IDs");
});
