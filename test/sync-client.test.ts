// The website's sync client (web/sync.js): the same vectors as the app's core/src/sync.rs, decrypting
// a ciphertext the app produced, and two browsers syncing through the real vault code.
import assert from "node:assert/strict";
import { test } from "node:test";

import { namespace } from "./support/do.ts";
import { SyncVault } from "../src/sync/vault.ts";
import { syncRoutes } from "../src/sync/routes.ts";
import * as sync from "../web/sync.js";

const SEVENS = new Uint8Array(32).fill(7);

test("sync client: matches the app's fixed vectors", async () => {
	assert.equal(sync.codeOf(SEVENS), "BTS1-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G");
	assert.deepEqual(sync.parseCode(sync.codeOf(SEVENS)), SEVENS);
	assert.deepEqual(sync.parseCode("bts1 0w3g e1r7 0w3g e1r7 0w3g e1r7 0w3g e1r7 0w3g e1r7 0w3g e1r7 0w3g"), SEVENS, "forgiving input");
	assert.equal(sync.parseCode("BTS1-1234"), null);
	assert.equal(await sync.vaultId(SEVENS), "b0d631bf62a827a8f44dcdfce33b8177");
	assert.equal(await sync.authOf(SEVENS), "7f5f4308e30827dc7bb18657ef48ee9b779115e2aff5efb0b9c8eec47ed7629a");
	assert.equal(sync.fnv("hello"), "4f9f2cab");
	const b = { settings: { hiddenChannels: "", hiddenWords: "", skip: { sponsor: true } }, library: { playlists: [{ id: "p1", name: "Road trip", items: [{ id: "aaaaaaaaaaa" }, { id: "bbbbbbbbbbb" }] }] } };
	assert.equal(sync.items(b).get("p:p1")[0], sync.fnv("Road trip\naaaaaaaaaaa,bbbbbbbbbbb"));
	assert.equal(sync.items(b).get("settings")[0], sync.fnv("||sponsor"));
});

test("sync client: decrypts what the app encrypted", async () => {
	// Produced by core/src/sync.rs with the all-sevens key.
	const plain = await sync.decrypt(SEVENS, "eD8Uq7WeFxWw4mdH", "gvVU6w0s+iCYhegqGp/cR/ub9KLbRJnZRDNvmzaTYNBVDcls8TROfGQveIFZPsvGy36O07+JLA==");
	assert.equal(plain, '{"format":"betteryts-sync","version":1}');
	const { iv, data } = await sync.encrypt(SEVENS, "round trip");
	assert.equal(await sync.decrypt(SEVENS, iv, data), "round trip");
	await assert.rejects(sync.decrypt(sync.newKey(), iv, data), /wrong code/);
});

test("sync client: two browsers converge, removals included", async () => {
	const ns = namespace(SyncVault);
	const server = async (url: string, init: RequestInit = {}) => syncRoutes(new Request(url, init), new URL(url).pathname, ns as never);
	const v = (id: string) => ({ id, title: id, channel: "A" });
	const code = sync.codeOf(sync.newKey());
	const a = { code, snapshot: {}, ledger: {} };
	const b = { code, snapshot: {}, ledger: {} };
	const base = "https://yts.foulfoxhacks.dev";

	const libA = { library: { favorites: [v("a"), v("b")], playlists: [], subscriptions: [], history: [{ id: "a", at: 1 }] } };
	let r = await sync.syncOnce(a, libA, { fetch: server, now: 1000, base });
	assert.equal(r.version, 1);
	const libB = { library: { favorites: [], playlists: [{ id: "p1", name: "Mix", items: [v("a")] }], subscriptions: [], history: [] } };
	r = await sync.syncOnce(b, libB, { fetch: server, now: 2000, base });
	assert.deepEqual(r.merged.library.favorites.map((x: { id: string }) => x.id).sort(), ["a", "b"], "B gets A's likes");
	assert.equal(r.merged.library.playlists.length, 1);

	// A unlikes "b" later; after A syncs and B syncs again, "b" is gone on B too.
	const libA2 = { library: { ...r.merged.library, favorites: [v("a")] } };
	await sync.syncOnce(a, { library: { favorites: [v("a"), v("b")], playlists: [{ id: "p1", name: "Mix", items: [v("a")] }], subscriptions: [], history: [] } }, { fetch: server, now: 3000, base });
	await sync.syncOnce(a, libA2, { fetch: server, now: 4000, base });
	r = await sync.syncOnce(b, r.merged, { fetch: server, now: 5000, base });
	assert.deepEqual(r.merged.library.favorites.map((x: { id: string }) => x.id), ["a"], "the removal reached B");
});

test("smart playlists on the website: built-ins and the app's rules, dislikes excluded", async () => {
	const { evaluate, seconds } = await import("../web/music.js");
	const v = (id: string, duration: string) => ({ id, title: `Song ${id}`, channel: "Artist", duration });
	const lib = { favorites: [v("aaaaaaaaaaa", "2:30"), v("bbbbbbbbbbb", "25:00"), v("ccccccccccc", "3:10")], history: [{ ...v("aaaaaaaaaaa", "2:30"), at: 1 }], playlists: [], disliked: [v("ccccccccccc", "3:10")] };
	assert.equal(seconds("1:02:05"), 3725);
	assert.deepEqual(evaluate(lib, { source: "all", maxSeconds: 180 }).map((x: { id: string }) => x.id), ["aaaaaaaaaaa"]);
	assert.deepEqual(evaluate(lib, { source: "favorites", maxPlays: 0 }).map((x: { id: string }) => x.id), ["bbbbbbbbbbb"], "never played, and the disliked one is left out");
	assert.deepEqual(evaluate(lib, { source: "favorites", sort: "longest" })[0].id, "bbbbbbbbbbb");
});
