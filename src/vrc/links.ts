// In-world linking state: see links-core.ts for the flow and its security notes.

import { DurableObject } from "cloudflare:workers";

import { CODE_TTL_MS, LIBRARY_SLOTS, LIBRARY_TTL_MS, type LinkLibrary, type LinkService, newCode } from "./links-core.ts";

export * from "./links-core.ts";

interface Device {
	code: string;
	service: LinkService;
	created: number;
	library: number | null;
}

/** One global object: activation codes, saved libraries and per-IP rate limits. */
export class VrcLinks extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, service TEXT NOT NULL, created INTEGER NOT NULL, library INTEGER)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS libraries (idx INTEGER PRIMARY KEY, data TEXT NOT NULL, used INTEGER NOT NULL, prev INTEGER)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS hits (bucket TEXT NOT NULL, at INTEGER NOT NULL)");
		this.sql.exec("CREATE INDEX IF NOT EXISTS hits_bucket ON hits (bucket, at)");
	}

	/** Sliding-window rate limit; true if allowed. Buckets are hashed IPs, never raw. */
	limit(bucket: string, max: number, windowMs: number): boolean {
		const now = Date.now();
		this.sql.exec("DELETE FROM hits WHERE at < ?", now - 24 * 3_600_000);
		const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hits WHERE bucket = ? AND at > ?", bucket, now - windowMs).toArray()[0]?.n ?? 0;
		if (n >= max) return false;
		this.sql.exec("INSERT INTO hits (bucket, at) VALUES (?, ?)", bucket, now);
		return true;
	}

	start(service: LinkService): { code: string; expiresIn: number } {
		const now = Date.now();
		this.sql.exec("DELETE FROM codes WHERE created < ?", now - CODE_TTL_MS);
		let code = newCode();
		while (this.sql.exec("SELECT 1 FROM codes WHERE code = ?", code).toArray().length) code = newCode();
		this.sql.exec("INSERT INTO codes (code, service, created, library) VALUES (?, ?, ?, NULL)", code, service, now);
		return { code, expiresIn: CODE_TTL_MS / 1000 };
	}

	device(code: string): Device | null {
		const row = this.sql.exec<{ code: string; service: LinkService; created: number; library: number | null }>("SELECT * FROM codes WHERE code = ?", code).toArray()[0];
		if (!row || Date.now() - row.created > CODE_TTL_MS) return null;
		return row;
	}

	/** The site finished an import for this code: store the library under a fresh number. */
	complete(code: string, lib: LinkLibrary): { ok: true } | { error: string; status: number } {
		const d = this.device(code);
		if (!d) return { error: "That code expired or doesn't exist. Get a new one in the world.", status: 404 };
		if (d.service !== lib.service) return { error: `That code is for ${d.service}`, status: 400 };
		if (d.library !== null) return { error: "That code was already used", status: 409 };
		const idx = this.freeSlot();
		this.sql.exec("INSERT OR REPLACE INTO libraries (idx, data, used, prev) VALUES (?, ?, ?, NULL)", idx, JSON.stringify(lib), Date.now());
		this.sql.exec("UPDATE codes SET library = ? WHERE code = ?", idx, code);
		return { ok: true };
	}

	library(idx: number): LinkLibrary | null {
		const row = this.sql.exec<{ data: string }>("SELECT data FROM libraries WHERE idx = ?", idx).toArray()[0];
		return row ? (JSON.parse(row.data) as LinkLibrary) : null;
	}

	/**
	 * A world loaded library `idx`: hand back the library and a new number for next time. The
	 * new number replaces the old one only once it's used, so a world that fails to save it can
	 * still come back with the old number.
	 */
	load(idx: number): { lib: LinkLibrary; next: number } | null {
		const now = Date.now();
		this.sql.exec("DELETE FROM libraries WHERE used < ?", now - LIBRARY_TTL_MS);
		const row = this.sql.exec<{ data: string; prev: number | null }>("SELECT data, prev FROM libraries WHERE idx = ?", idx).toArray()[0];
		if (!row) return null;
		// Using a new number retires the one it replaced.
		if (row.prev !== null) this.sql.exec("DELETE FROM libraries WHERE idx = ?", row.prev);
		// A pending replacement from an earlier load of this same number is dropped too.
		this.sql.exec("DELETE FROM libraries WHERE prev = ?", idx);
		const next = this.freeSlot();
		this.sql.exec("INSERT INTO libraries (idx, data, used, prev) VALUES (?, ?, ?, ?)", next, row.data, now, idx);
		this.sql.exec("UPDATE libraries SET used = ?, prev = NULL WHERE idx = ?", now, idx);
		return { lib: JSON.parse(row.data) as LinkLibrary, next };
	}

	/** A random unused library number; if all are taken, the least recently used is evicted. */
	private freeSlot(): number {
		for (let i = 0; i < 32; i++) {
			const n = crypto.getRandomValues(new Uint32Array(1))[0] % LIBRARY_SLOTS;
			if (!this.sql.exec("SELECT 1 FROM libraries WHERE idx = ?", n).toArray().length) return n;
		}
		const oldest = this.sql.exec<{ idx: number }>("SELECT idx FROM libraries ORDER BY used ASC LIMIT 1").toArray()[0];
		const n = oldest?.idx ?? 0;
		this.sql.exec("DELETE FROM libraries WHERE idx = ?", n);
		return n;
	}
}
