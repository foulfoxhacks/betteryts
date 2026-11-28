// Encrypted library sync: the vault Durable Object (on Node's SQLite) and /api/sync routes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeClock, namespace } from "./support/do.ts";
import { IDLE_MS, SyncVault, WRITES_PER_HOUR } from "../src/sync/vault.ts";
import { syncRoutes } from "../src/sync/routes.ts";

const ID = "0123456789abcdef0123456789abcdef";
const AUTH = "a".repeat(64);
const IV = "AAAAAAAAAAAAAAAA";
const DATA = "Q2lwaGVydGV4dCBnb2VzIGhlcmUhIQ==";
const url = (id = ID) => `https://yts.foulfoxhacks.dev/api/sync/${id}`;
const call = (ns: ReturnType<typeof namespace>, method: string, opts: { auth?: string; body?: unknown; origin?: string; id?: string } = {}) =>
	syncRoutes(
		new Request(url(opts.id), {
			method,
			headers: { ...(opts.auth !== undefined ? { Authorization: `Bearer ${opts.auth}` } : {}), ...(opts.origin ? { Origin: opts.origin } : {}), "Content-Type": "application/json" },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		}),
		`/api/sync/${opts.id ?? ID}`,
		ns as never,
	);

test("sync: first write claims the vault; reads need the same secret", async () => {
	const ns = namespace(SyncVault);
	assert.equal((await call(ns, "GET", { auth: AUTH })).status, 404, "nothing yet");
	const put = await (await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: DATA, baseVersion: 0 } })).json();
	assert.deepEqual([put.ok, put.data.version], [true, 1]);
	const got = await (await call(ns, "GET", { auth: AUTH })).json();
	assert.deepEqual([got.data.iv, got.data.data, got.data.version], [IV, DATA, 1]);
	assert.equal((await call(ns, "GET", { auth: "b".repeat(64) })).status, 403, "another secret can't read");
	assert.equal((await call(ns, "PUT", { auth: "b".repeat(64), body: { iv: IV, data: DATA, baseVersion: 1 } })).status, 403, "or overwrite");
	assert.equal((await call(ns, "GET", {})).status, 401, "no credentials");
	assert.equal((await call(ns, "GET", { auth: AUTH, id: "not-hex" })).status, 404);
});

test("sync: versions stop silent overwrites", async () => {
	const ns = namespace(SyncVault);
	await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: DATA, baseVersion: 0 } });
	const stale = await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: DATA, baseVersion: 0 } });
	const body = await stale.json();
	assert.deepEqual([stale.status, body.error.code, body.error.version], [409, "CONFLICT", 1]);
	assert.equal((await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: DATA, baseVersion: 1 } })).status, 200);
});

test("sync: input checks, rate limit, cross-site refusal, erase and expiry", async () => {
	const ns = namespace(SyncVault);
	assert.equal((await call(ns, "PUT", { auth: AUTH, body: { iv: "short", data: DATA, baseVersion: 0 } })).status, 400);
	assert.equal((await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: "<script>", baseVersion: 0 } })).status, 400);
	assert.equal((await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: "A".repeat(3_100_000), baseVersion: 0 } })).status, 413);
	assert.equal((await call(ns, "GET", { auth: AUTH, origin: "https://evil.example" })).status, 403);
	assert.equal((await call(ns, "PATCH", { auth: AUTH })).status, 405);
	let v = 0;
	for (let i = 0; i < WRITES_PER_HOUR; i++) v = (await (await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: DATA, baseVersion: v } })).json()).data.version;
	assert.equal((await call(ns, "PUT", { auth: AUTH, body: { iv: IV, data: DATA, baseVersion: v } })).status, 429);
	assert.equal((await call(ns, "DELETE", { auth: AUTH })).status, 200);
	assert.equal((await call(ns, "GET", { auth: AUTH })).status, 404, "erased");

	const clock = fakeClock();
	try {
		const ns2 = namespace(SyncVault);
		await call(ns2, "PUT", { auth: AUTH, body: { iv: IV, data: DATA, baseVersion: 0 } });
		clock.advance(IDLE_MS);
		await (ns2.getByName(ID) as SyncVault).alarm();
		assert.equal((await call(ns2, "GET", { auth: AUTH })).status, 404, "idle vaults expire");
	} finally {
		clock.restore();
	}
});
