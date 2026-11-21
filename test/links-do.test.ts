// In-world linking v2, end to end: the real VrcLinks Durable Object and the linking routes, on
// Node's SQLite (test/support/do.ts). Covers the code lifecycle, owner binding, saved-library keys,
// lockouts, deletion and expiry.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeClock, namespace } from "./support/do.ts";
import { VrcLinks } from "../src/vrc/links.ts";
import { VrcPool } from "../src/vrc/pool.ts";
import { clientNet, CODE_TTL_MS, LIBRARY_TTL_MS, type LinkLibrary, MAX_FAILED_PAIRS } from "../src/vrc/links-core.ts";
import { linkRoutes, linkSlot } from "../src/vrc/linking.ts";

const WORLD = "203.0.113.10";
const SCANNER = "198.51.100.7";
const ORIGIN = "https://yts.foulfoxhacks.dev";
const lib: LinkLibrary = { service: "youtube", playlists: [{ name: "Mix", tracks: [{ id: "dQw4w9WgXcQ", title: "Song", channel: "Artist" }] }] };

function setup() {
	const env = { VRC_LINKS: namespace(VrcLinks), VRC_POOL: namespace(VrcPool) } as unknown as Env;
	const links = (env as unknown as { VRC_LINKS: { getByName(n: string): VrcLinks } }).VRC_LINKS.getByName("links-v1");
	return { env, links };
}

const get = (env: Env, path: string, ip: string) => linkRoutes(new Request(ORIGIN + path, { headers: { "CF-Connecting-IP": ip } }), new URL(ORIGIN + path), env);
const post = (env: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
	linkRoutes(
		new Request(ORIGIN + path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "192.0.2.50", ...headers } }),
		new URL(ORIGIN + path),
		env,
	);
const body = async (r: Response | null) => (assert.ok(r), (await r.json()) as Record<string, unknown>);

test("clientNet: IPv4 as is, IPv6 by /64", () => {
	assert.equal(clientNet("203.0.113.10"), "203.0.113.10");
	assert.equal(clientNet("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
	assert.equal(clientNet("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64", "same /64, different host part");
	assert.equal(clientNet("2001:db8::1"), "2001:db8:0:0::/64");
	assert.equal(clientNet("::ffff:198.51.100.7"), "198.51.100.7", "IPv4-mapped");
	assert.notEqual(clientNet("2001:db8:1:2::1"), clientNet("2001:db8:1:3::1"));
});

test("linking: only the world that asked for a code can see it or its library", async () => {
	const { env } = setup();
	const start = await body(await get(env, "/vrc/link/start/youtube", WORLD));
	assert.equal(start.ok, true);
	const code = start.code as string;

	// Someone walking the public pool slots sees nothing.
	assert.deepEqual(await body(await linkSlot(code, env, SCANNER)), { v: 2, ok: true, status: "expired" });
	assert.equal((await body(await linkSlot(code, env, WORLD))).status, "waiting");

	const done = await body(await post(env, "/api/inworld/complete", { code, service: "youtube", library: lib, save: true }));
	assert.equal(done.ok, true);

	const leak = await body(await linkSlot(code, env, SCANNER));
	assert.equal(leak.status, "expired", "the library and its key never reach another caller");
	assert.equal(leak.library, undefined);
	const mine = await body(await linkSlot(code, env, WORLD));
	assert.equal(mine.status, "linked");
	assert.ok(mine.library && typeof (mine.library as { a: number }).a === "number", "saved: the world gets a key");
});

test("linking: codes are single use, service-bound and expire", async () => {
	const clock = fakeClock();
	try {
		const { env } = setup();
		const code = (await body(await get(env, "/vrc/link/start/spotify", WORLD))).code as string;
		const wrong = await post(env, "/api/inworld/complete", { code, service: "youtube", library: lib });
		assert.equal(wrong?.status, 400, "a Spotify code can't take a YouTube library");

		const spotifyLib = { ...lib, service: "spotify" };
		assert.equal((await post(env, "/api/inworld/complete", { code, service: "spotify", library: spotifyLib }))?.status, 200);
		assert.equal((await post(env, "/api/inworld/complete", { code, service: "spotify", library: spotifyLib }))?.status, 409, "used once");
		assert.equal((await get(env, `/api/inworld/check?code=${code}`, WORLD))?.status, 409);

		const later = (await body(await get(env, "/vrc/link/start/youtube", WORLD))).code as string;
		clock.advance(CODE_TTL_MS + 1);
		assert.equal((await get(env, `/api/inworld/check?code=${later}`, WORLD))?.status, 404, "expired after 10 minutes");
		assert.equal((await post(env, "/api/inworld/complete", { code: later, service: "youtube", library: lib }))?.status, 404);
		assert.equal((await body(await linkSlot(later, env, WORLD))).status, "expired");
		// "Just this visit" libraries go with their code.
		assert.equal((await body(await linkSlot(code, env, WORLD))).status, "expired");
	} finally {
		clock.restore();
	}
});

test("linking: site POSTs need JSON from this site", async () => {
	const { env } = setup();
	const code = (await body(await get(env, "/vrc/link/start/youtube", WORLD))).code as string;
	const evil = await post(env, "/api/inworld/complete", { code, service: "youtube", library: lib }, { Origin: "https://evil.example" });
	assert.equal(evil?.status, 403);
	const form = await linkRoutes(
		new Request(`${ORIGIN}/api/inworld/complete`, { method: "POST", body: "x", headers: { "Content-Type": "text/plain", "CF-Connecting-IP": "192.0.2.50" } }),
		new URL(`${ORIGIN}/api/inworld/complete`),
		env,
	);
	assert.equal(form?.status, 403, "no preflight-free text/plain posts");
	const junk = await post(env, "/api/inworld/complete", { code, service: "youtube", library: { playlists: [{ name: "x", tracks: [{ id: "<script>" }] }] } });
	assert.equal(junk?.status, 400, "nothing playable: rejected");
});

test("saved libraries: two-part key, rotation, lockout, delete and expiry", async () => {
	const clock = fakeClock();
	try {
		const { env } = setup();
		const code = (await body(await get(env, "/vrc/link/start/youtube", WORLD))).code as string;
		await post(env, "/api/inworld/complete", { code, service: "youtube", library: lib, save: true });
		const k1 = (await body(await linkSlot(code, env, WORLD))).library as { a: number; b: number };

		// Next visit: /vrc/l/{a} then /vrc/k/{b}.
		const load = async (k: { a: number; b: number }, ip = WORLD) => {
			assert.equal((await body(await get(env, `/vrc/l/${k.a}`, ip))).status, "next");
			return body(await get(env, `/vrc/k/${k.b}`, ip));
		};
		assert.equal((await body(await get(env, `/vrc/k/${k1.b}`, WORLD))).error, "Load /vrc/l/{a} first (within a minute)");
		const r1 = await load(k1);
		assert.equal(r1.status, "linked");
		const k2 = r1.library as { a: number; b: number };
		assert.notDeepEqual(k2, k1, "the key changes on every load");

		// The old key still works until the new one is used (a world that crashed before saving).
		const again = await load(k1);
		assert.equal(again.status, "linked");
		const k3 = again.library as { a: number; b: number };
		const r3 = await load(k3);
		assert.equal(r3.status, "linked");
		assert.equal((await load(k1)).status, "missing", "using a newer key retires the old one");

		// Wrong keys lock the caller out for an hour.
		const attacker = "198.51.100.99";
		for (let i = 0; i < MAX_FAILED_PAIRS; i++) assert.equal((await load({ a: 1, b: i }, attacker)).status, "missing");
		assert.match(String((await load(r3.library as { a: number; b: number }, attacker)).error), /Too many wrong keys/);
		// A different address in the same IPv6 /64 is the same caller.
		for (let i = 0; i < MAX_FAILED_PAIRS; i++) await load({ a: 2, b: i }, `2001:db8:5:6::${i + 1}`);
		assert.match(String((await load({ a: 3, b: 3 }, "2001:db8:5:6:ffff::9")).error), /Too many wrong keys/);

		// The site can view, then delete, by key.
		const k4 = r3.library as { a: number; b: number };
		const key = `${String(k4.a).padStart(4, "0")}-${String(k4.b).padStart(4, "0")}`;
		const view = await body(await post(env, "/api/inworld/library", { key, action: "view" }));
		assert.equal(view.ok, true);
		assert.equal((await body(await post(env, "/api/inworld/library", { key, action: "delete" }))).ok, true);
		assert.equal((await post(env, "/api/inworld/library", { key, action: "view" }))?.status, 404, "deleted");

		// Libraries expire 30 days after saving, however often they're loaded.
		const code2 = (await body(await get(env, "/vrc/link/start/youtube", WORLD))).code as string;
		await post(env, "/api/inworld/complete", { code: code2, service: "youtube", library: lib, save: true });
		let k = (await body(await linkSlot(code2, env, WORLD))).library as { a: number; b: number };
		for (let day = 0; day < 3; day++) {
			clock.advance(10 * 86_400_000);
			const r = await load(k, `203.0.113.${20 + day}`);
			if (day < 2) {
				assert.equal(r.status, "linked", `day ${(day + 1) * 10}`);
				k = r.library as { a: number; b: number };
			} else assert.equal(r.status, "missing", "gone after 30 days (rotation never extends it)");
		}
		assert.ok(LIBRARY_TTL_MS === 30 * 86_400_000);
	} finally {
		clock.restore();
	}
});

test("Unlink (/vrc/forget) deletes only what this caller just loaded", async () => {
	const { env } = setup();
	const code = (await body(await get(env, "/vrc/link/start/youtube", WORLD))).code as string;
	await post(env, "/api/inworld/complete", { code, service: "youtube", library: lib, save: true });
	const k = (await body(await linkSlot(code, env, WORLD))).library as { a: number; b: number };
	assert.equal((await body(await get(env, "/vrc/forget", SCANNER))).status, "nothing");
	assert.equal((await body(await get(env, "/vrc/forget", WORLD))).status, "forgotten");
	await get(env, `/vrc/l/${k.a}`, WORLD);
	assert.equal((await body(await get(env, `/vrc/k/${k.b}`, WORLD))).status, "missing");
});

test("owner check survives midnight UTC (yesterday's salt is kept one day)", async () => {
	const clock = fakeClock(Date.UTC(2026, 10, 21, 23, 58, 0));
	try {
		const { env } = setup();
		const code = (await body(await get(env, "/vrc/link/start/youtube", WORLD))).code as string;
		clock.advance(4 * 60_000); // 00:02 the next day
		assert.equal((await body(await linkSlot(code, env, WORLD))).status, "waiting");
		assert.equal((await body(await linkSlot(code, env, SCANNER))).status, "expired");
	} finally {
		clock.restore();
	}
});

test("rate limit: activation codes per caller", async () => {
	const { env } = setup();
	for (let i = 0; i < 30; i++) assert.equal((await body(await get(env, "/vrc/link/start/youtube", WORLD))).ok, true);
	const r = await body(await get(env, "/vrc/link/start/youtube", WORLD));
	assert.equal(r.ok, false);
	assert.match(String(r.error), /Too many codes/);
	assert.equal((await body(await get(env, "/vrc/link/start/youtube", SCANNER))).ok, true, "other callers unaffected");
});
