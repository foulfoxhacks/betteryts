// In-world linking state (one global object). See links-core.ts for the flow and privacy notes.

import { DurableObject } from "cloudflare:workers";

import { clientNet, CODE_TTL_MS, keyPart, type LibraryKey, LIBRARY_TTL_MS, type LinkLibrary, type LinkService, MAX_FAILED_PAIRS, newCode, STEP_WINDOW_MS } from "./links-core.ts";

export * from "./links-core.ts";

interface Device {
	code: string;
	service: LinkService;
	created: number;
	lib: number | null;
}

type LibRow = {
	id: number;
	a: number | null;
	b: number | null;
	data: string;
	created: number;
	prev: number | null;
};

export class VrcLinks extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		// v2 tables (v1 kept account names and 180-day libraries: dropped).
		this.sql.exec("DROP TABLE IF EXISTS libraries");
		this.sql.exec("DROP TABLE IF EXISTS codes");
		this.sql.exec("CREATE TABLE IF NOT EXISTS codes2 (code TEXT PRIMARY KEY, service TEXT NOT NULL, created INTEGER NOT NULL, lib INTEGER)");
		// Which caller (hashed) asked for the code: only it may poll the code or receive the library.
		// Pool slots are public and numbered, so without this anyone could read pending codes and
		// delivered libraries (and their save keys) by walking /vrc/p/0…N.
		if (!this.sql.exec<{ name: string }>("PRAGMA table_info(codes2)").toArray().some((c) => c.name === "owner")) {
			this.sql.exec("ALTER TABLE codes2 ADD COLUMN owner TEXT");
		}
		this.sql.exec("CREATE TABLE IF NOT EXISTS libs (id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER, b INTEGER, data TEXT NOT NULL, created INTEGER NOT NULL, prev INTEGER)");
		this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS libs_key ON libs (a, b) WHERE a IS NOT NULL");
		this.sql.exec("CREATE TABLE IF NOT EXISTS hits (bucket TEXT NOT NULL, at INTEGER NOT NULL)");
		this.sql.exec("CREATE INDEX IF NOT EXISTS hits_bucket ON hits (bucket, at)");
		// Per caller (hashed): the first half of a key being entered, and the library last delivered (for /vrc/forget).
		this.sql.exec("CREATE TABLE IF NOT EXISTS steps (who TEXT PRIMARY KEY, a INTEGER, a_at INTEGER, lib INTEGER, lib_at INTEGER)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
		// TikTok sign-ins in progress: OAuth state → the code it's for (10 minutes, one use). No tokens.
		this.sql.exec("CREATE TABLE IF NOT EXISTS tt_states (state TEXT PRIMARY KEY, code TEXT NOT NULL, save INTEGER NOT NULL, created INTEGER NOT NULL)");
	}

	/** Expired codes, "this visit only" libraries, old libraries and day-old records go. */
	private sweep(now: number) {
		this.sql.exec("DELETE FROM libs WHERE a IS NULL AND id NOT IN (SELECT lib FROM codes2 WHERE lib IS NOT NULL AND created >= ?)", now - CODE_TTL_MS);
		this.sql.exec("DELETE FROM codes2 WHERE created < ?", now - CODE_TTL_MS);
		this.sql.exec("DELETE FROM tt_states WHERE created < ?", now - CODE_TTL_MS);
		this.sql.exec("DELETE FROM libs WHERE created <= ?", now - LIBRARY_TTL_MS);
		this.sql.exec("DELETE FROM hits WHERE at < ?", now - 24 * 3_600_000);
		this.sql.exec("DELETE FROM steps WHERE COALESCE(a_at, 0) < ? AND COALESCE(lib_at, 0) < ?", now - STEP_WINDOW_MS, now - STEP_WINDOW_MS);
	}

	/** HMAC-SHA-256 of the IP with a secret random key replaced every UTC day (hashes can't be reversed or linked across days). */
	private async who(ip: string, scope: string, at = Date.now()): Promise<string> {
		const today = new Date(Date.now()).toISOString().slice(0, 10);
		const day = new Date(at).toISOString().slice(0, 10);
		let salt = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", `salt:${day}`).toArray()[0]?.v;
		if (!salt) {
			// Only today's salt is ever made; an older day's is gone, so its hashes can't be matched.
			if (day !== today) return "";
			salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
			// Yesterday's salt is kept one more day, only so codes started just before midnight still
			// match their owner (codes last 10 minutes); anything older is deleted.
			const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
			this.sql.exec("DELETE FROM meta WHERE k LIKE 'salt:%' AND k != ?", `salt:${yesterday}`);
			this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?)", `salt:${day}`, salt);
		}
		ip = clientNet(ip);
		// HMAC with a secret random key that never leaves this object and is replaced every UTC day:
		// without it, hashes can't be reversed by trying every IP address.
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const d = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}|${ip}`));
		return btoa(String.fromCharCode(...new Uint8Array(d).slice(0, 12)));
	}

	/** Sliding-window rate limit; true if allowed. */
	async limit(ip: string, scope: string, max: number, windowMs: number): Promise<boolean> {
		const now = Date.now();
		this.sweep(now);
		const bucket = await this.who(ip, scope);
		const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hits WHERE bucket = ? AND at > ?", bucket, now - windowMs).toArray()[0]?.n ?? 0;
		if (n >= max) return false;
		this.sql.exec("INSERT INTO hits (bucket, at) VALUES (?, ?)", bucket, now);
		return true;
	}

	async start(service: LinkService, ip: string): Promise<{ code: string; expiresIn: number }> {
		const now = Date.now();
		this.sweep(now);
		let code = newCode();
		while (this.sql.exec("SELECT 1 FROM codes2 WHERE code = ?", code).toArray().length) code = newCode();
		this.sql.exec("INSERT INTO codes2 (code, service, created, lib, owner) VALUES (?, ?, ?, NULL, ?)", code, service, now, await this.who(ip, "owner"));
		return { code, expiresIn: CODE_TTL_MS / 1000 };
	}

	device(code: string): Device | null {
		const row = this.sql.exec<{ code: string; service: LinkService; created: number; lib: number | null }>("SELECT code, service, created, lib FROM codes2 WHERE code = ?", code).toArray()[0];
		if (!row || Date.now() - row.created > CODE_TTL_MS) return null;
		return row;
	}

	/**
	 * The world's poll: the code's state, but only for the caller that asked for the code. Anyone
	 * else (someone walking the public pool slots) sees "expired" and learns nothing. Codes from
	 * before owners were recorded have none and stay readable until they expire (10 minutes).
	 */
	async poll(code: string, ip: string): Promise<Device | null> {
		const row = this.sql.exec<{ code: string; service: LinkService; created: number; lib: number | null; owner: string | null }>("SELECT * FROM codes2 WHERE code = ?", code).toArray()[0];
		if (!row || Date.now() - row.created > CODE_TTL_MS) return null;
		if (row.owner !== null && row.owner !== (await this.who(ip, "owner", row.created))) return null;
		return { code: row.code, service: row.service, created: row.created, lib: row.lib };
	}

	private freeKey(): LibraryKey {
		for (;;) {
			const k = { a: keyPart(), b: keyPart() };
			if (!this.sql.exec("SELECT 1 FROM libs WHERE a = ? AND b = ?", k.a, k.b).toArray().length) return k;
		}
	}

	/** The site sent a library for this code. `save`: keep it for next visit (else it ends with the code). */
	complete(code: string, lib: LinkLibrary, save: boolean): { ok: true } | { error: string; status: number } {
		const d = this.device(code);
		if (!d) return { error: "That code expired or doesn't exist. Get a new one in the world.", status: 404 };
		if (d.service !== lib.service) return { error: `That code is for ${d.service}`, status: 400 };
		if (d.lib !== null) return { error: "That code was already used", status: 409 };
		const key = save ? this.freeKey() : null;
		this.sql.exec("INSERT INTO libs (a, b, data, created, prev) VALUES (?, ?, ?, ?, NULL)", key?.a ?? null, key?.b ?? null, JSON.stringify(lib), Date.now());
		const id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").toArray()[0].id;
		this.sql.exec("UPDATE codes2 SET lib = ? WHERE code = ?", id, code);
		return { ok: true };
	}

	/** TikTok: remember which code a sign-in is for (the state goes to TikTok and comes back). */
	ttBegin(state: string, code: string, save: boolean): { ok: true } | { error: string } {
		const d = this.device(code);
		if (!d) return { error: "That code expired or doesn't exist. Get a new one in the world." };
		if (d.service !== "tiktok") return { error: `That code is for ${d.service === "spotify" ? "Spotify" : "YouTube"}; use the link shown in the world` };
		if (d.lib !== null) return { error: "That code was already used" };
		this.sql.exec("INSERT INTO tt_states (state, code, save, created) VALUES (?, ?, ?, ?)", state, code, save ? 1 : 0, Date.now());
		return { ok: true };
	}

	/** TikTok callback: the code and choice for this state, once (it's deleted on read). */
	ttTake(state: string): { code: string; save: boolean } | null {
		this.sweep(Date.now());
		const r = this.sql.exec<{ code: string; save: number }>("SELECT code, save FROM tt_states WHERE state = ?", state).toArray()[0];
		if (!r) return null;
		this.sql.exec("DELETE FROM tt_states WHERE state = ?", state);
		return { code: r.code, save: r.save === 1 };
	}

	private row(id: number): LibRow | null {
		return this.sql.exec<LibRow>("SELECT * FROM libs WHERE id = ?", id).toArray()[0] ?? null;
	}

	/** What the world's poll shows once linked; remembers it for /vrc/forget from this caller. */
	async delivered(code: string, ip: string): Promise<{ lib: LinkLibrary; key: LibraryKey | null; expiresAt: number | null } | null> {
		const d = await this.poll(code, ip);
		if (!d || d.lib === null) return null;
		const r = this.row(d.lib);
		if (!r) return null;
		await this.remember(ip, r.id);
		return { lib: JSON.parse(r.data), key: r.a === null ? null : { a: r.a, b: r.b as number }, expiresAt: r.a === null ? null : r.created + LIBRARY_TTL_MS };
	}

	private async remember(ip: string, id: number) {
		const who = await this.who(ip, "steps");
		this.sql.exec("INSERT INTO steps (who, lib, lib_at) VALUES (?, ?, ?) ON CONFLICT(who) DO UPDATE SET lib = excluded.lib, lib_at = excluded.lib_at", who, id, Date.now());
	}

	/** /vrc/l/{a}: the first half of a key. Says nothing about whether it exists. */
	async stepA(ip: string, a: number): Promise<void> {
		const who = await this.who(ip, "steps");
		this.sql.exec("INSERT INTO steps (who, a, a_at) VALUES (?, ?, ?) ON CONFLICT(who) DO UPDATE SET a = excluded.a, a_at = excluded.a_at", who, a, Date.now());
	}

	/**
	 * /vrc/k/{b}: completes the key started by this caller's /vrc/l/{a}. On success the library
	 * comes back with a new key; the old key keeps working only until the new one is used once
	 * (so a world that crashed before saving can recover). Failed pairs count toward a lockout.
	 */
	async stepB(ip: string, b: number): Promise<{ lib: LinkLibrary; key: LibraryKey; expiresAt: number } | "missing" | "locked" | "no-step"> {
		const now = Date.now();
		this.sweep(now);
		const failBucket = await this.who(ip, "fail");
		const fails = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hits WHERE bucket = ? AND at > ?", failBucket, now - 3_600_000).toArray()[0]?.n ?? 0;
		if (fails >= MAX_FAILED_PAIRS) return "locked";
		const who = await this.who(ip, "steps");
		const step = this.sql.exec<{ a: number | null; a_at: number | null }>("SELECT a, a_at FROM steps WHERE who = ?", who).toArray()[0];
		if (!step || step.a === null || now - (step.a_at ?? 0) > STEP_WINDOW_MS) return "no-step";
		this.sql.exec("UPDATE steps SET a = NULL, a_at = NULL WHERE who = ?", who);
		const r = this.sql.exec<LibRow>("SELECT * FROM libs WHERE a = ? AND b = ?", step.a, b).toArray()[0];
		if (!r) {
			this.sql.exec("INSERT INTO hits (bucket, at) VALUES (?, ?)", failBucket, now);
			return "missing";
		}
		// Using a newer key retires the one it replaced; an unused replacement from an earlier load goes too.
		if (r.prev !== null) this.sql.exec("DELETE FROM libs WHERE id = ?", r.prev);
		this.sql.exec("DELETE FROM libs WHERE prev = ?", r.id);
		this.sql.exec("UPDATE libs SET prev = NULL WHERE id = ?", r.id);
		const key = this.freeKey();
		// The replacement keeps the original save time: rotation never extends retention.
		this.sql.exec("INSERT INTO libs (a, b, data, created, prev) VALUES (?, ?, ?, ?, ?)", key.a, key.b, r.data, r.created, r.id);
		const id = this.sql.exec<{ id: number }>("SELECT last_insert_rowid() AS id").toArray()[0].id;
		await this.remember(ip, id);
		return { lib: JSON.parse(r.data), key, expiresAt: r.created + LIBRARY_TTL_MS };
	}

	/** Deletes a library and everything chained to it (its pending replacement or predecessor). */
	private erase(id: number): boolean {
		const r = this.row(id);
		if (!r) return false;
		this.sql.exec("DELETE FROM libs WHERE id = ? OR prev = ? OR id = ?", id, id, r.prev ?? -1);
		this.sql.exec("UPDATE codes2 SET lib = NULL WHERE lib = ?", id);
		return true;
	}

	/** /vrc/forget: the library this caller loaded or linked in the last minute. */
	async forgetRecent(ip: string): Promise<boolean> {
		const who = await this.who(ip, "steps");
		const s = this.sql.exec<{ lib: number | null; lib_at: number | null }>("SELECT lib, lib_at FROM steps WHERE who = ?", who).toArray()[0];
		if (!s || s.lib === null || Date.now() - (s.lib_at ?? 0) > STEP_WINDOW_MS) return false;
		this.sql.exec("UPDATE steps SET lib = NULL, lib_at = NULL WHERE who = ?", who);
		return this.erase(s.lib);
	}

	/** Site: see or delete a saved library by its key. Wrong keys count toward the lockout. */
	async byKey(ip: string, key: LibraryKey, action: "view" | "delete"): Promise<{ lib: LinkLibrary; created: number } | "missing" | "locked" | "deleted"> {
		const now = Date.now();
		this.sweep(now);
		const failBucket = await this.who(ip, "fail");
		const fails = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hits WHERE bucket = ? AND at > ?", failBucket, now - 3_600_000).toArray()[0]?.n ?? 0;
		if (fails >= MAX_FAILED_PAIRS) return "locked";
		const r = this.sql.exec<LibRow>("SELECT * FROM libs WHERE a = ? AND b = ?", key.a, key.b).toArray()[0];
		if (!r) {
			this.sql.exec("INSERT INTO hits (bucket, at) VALUES (?, ?)", failBucket, now);
			return "missing";
		}
		if (action === "delete") {
			this.erase(r.id);
			return "deleted";
		}
		return { lib: JSON.parse(r.data), created: r.created };
	}
}

