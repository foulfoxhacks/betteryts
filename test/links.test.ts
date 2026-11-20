// In-world linking v2: codes, keys and library checks (the Durable Object flow is exercised in dev).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLibrary, formatKey, KEY_SPACE, keyPart, newCode, normalizeCode, parseKey, renderLibrary } from "../src/vrc/links-core.ts";

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

test("links: two-part library keys", () => {
	for (let i = 0; i < 1000; i++) {
		const k = keyPart();
		assert.ok(Number.isInteger(k) && k >= 0 && k < KEY_SPACE);
	}
	assert.deepEqual(parseKey("0042-9001"), { a: 42, b: 9001 });
	assert.deepEqual(parseKey(" 42 9001 "), { a: 42, b: 9001 });
	assert.deepEqual(parseKey({ a: 1, b: 2 }), { a: 1, b: 2 });
	assert.equal(parseKey("10000-1"), null, "each half is below KEY_SPACE");
	assert.equal(parseKey("12-ab"), null);
	assert.equal(parseKey(null), null);
	assert.equal(formatKey({ a: 42, b: 7 }), "0042-0007");
});

test("links: libraries keep only songs, and render with slots", () => {
	const lib = cleanLibrary(
		{
			account: "Sammy",
			playlists: [
				{ name: "Road trip", tracks: [{ id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", channel: "Rick Astley", extra: "x" }, { id: "bad", title: "x" }] },
				{ name: "Empty", tracks: [] },
				{ name: "x".repeat(200), tracks: Array.from({ length: 300 }, () => ({ id: "jNQXAC9IVRw", title: "zoo" })) },
			],
		},
		"youtube",
	);
	assert.ok(!("account" in lib), "account names are never kept");
	assert.ok(!JSON.stringify(lib).includes("extra"), "unknown fields are dropped");
	assert.equal(lib.playlists.length, 2, "empty playlists are dropped");
	assert.equal(lib.playlists[0].tracks.length, 1, "bad IDs are dropped");
	assert.equal(lib.playlists[1].tracks.length, 200, "per-playlist cap");
	assert.equal(lib.playlists[1].name.length, 60);
	assert.throws(() => cleanLibrary({ playlists: [] }, "youtube"), /Nothing to send/);
	assert.throws(() => cleanLibrary(null, "youtube"), /Expected/);

	const saved = renderLibrary(lib, Array.from({ length: 201 }, (_, i) => 1000 + i), { a: 12, b: 34 }, 123);
	assert.equal(saved.v, 2);
	assert.deepEqual(saved.library, { a: 12, b: 34 });
	assert.equal(saved.playlists[0].tracks[0].slot, 1000);
	assert.equal(saved.playlists[1].tracks[0].slot, 1001);
	assert.ok(!JSON.stringify(saved).includes("dQw4w9WgXcQ"), "the world gets slots, not IDs");
	assert.equal(renderLibrary(lib, [], null, null).library, null, "this visit only: no key");
});
