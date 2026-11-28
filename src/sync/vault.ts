// BetterYTS Sync: an encrypted library vault, one Durable Object per vault ID (docs/sync.md).
//
// Devices encrypt the library themselves (AES-256-GCM, key from the user's sync code); this object
// only ever sees ciphertext. It stores the SHA-256 of the vault's auth secret, claims the vault on
// the first write, refuses other secrets, and versions every write so two devices can't silently
// overwrite each other (the loser gets 409 and merges). Idle vaults are deleted after a year.

import { DurableObject } from "cloudflare:workers";

export const MAX_CIPHERTEXT = 3_000_000; // base64 characters (~2.2 MB of encrypted library)
export const WRITES_PER_HOUR = 120;
export const IDLE_MS = 365 * 24 * 60 * 60 * 1000;

export type VaultResult =
	| { ok: true; version: number; updatedAt: number; iv?: string; data?: string }
	| { ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "RATE_LIMITED" | "TOO_LARGE" | "BAD_REQUEST"; message: string; status: number; version?: number };

type Row = { auth_hash: string; version: number; updated: number; iv: string; data: string };

export const isVaultId = (id: string) => /^[0-9a-f]{32}$/.test(id);
export const isAuthHash = (h: string) => /^[0-9a-f]{64}$/.test(h);
const isIv = (iv: string) => /^[A-Za-z0-9+/]{16}$/.test(iv); // 12 bytes, base64
const isB64 = (s: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(s);

export class SyncVault extends DurableObject {
	private ready = false;

	private sql() {
		const sql = this.ctx.storage.sql;
		if (!this.ready) {
			sql.exec("CREATE TABLE IF NOT EXISTS vault (k INTEGER PRIMARY KEY CHECK (k = 1), auth_hash TEXT NOT NULL, version INTEGER NOT NULL, updated INTEGER NOT NULL, iv TEXT NOT NULL, data TEXT NOT NULL)");
			sql.exec("CREATE TABLE IF NOT EXISTS writes (at INTEGER NOT NULL)");
			this.ready = true;
		}
		return sql;
	}

	private row(): Row | undefined {
		return this.sql().exec<Row>("SELECT auth_hash, version, updated, iv, data FROM vault WHERE k = 1").toArray()[0];
	}

	async read(authHash: string): Promise<VaultResult> {
		const r = this.row();
		if (!r) return { ok: false, code: "NOT_FOUND", message: "Nothing synced yet", status: 404 };
		if (r.auth_hash !== authHash) return { ok: false, code: "FORBIDDEN", message: "Wrong sync code", status: 403 };
		return { ok: true, version: r.version, updatedAt: r.updated, iv: r.iv, data: r.data };
	}

	/** Writes a new encrypted library. `baseVersion` must match the stored one (0 for a new vault). */
	async write(authHash: string, baseVersion: number, iv: string, data: string): Promise<VaultResult> {
		if (!isIv(iv) || !isB64(data) || data.length < 24) return { ok: false, code: "BAD_REQUEST", message: "Expected { iv, data } in base64", status: 400 };
		if (data.length > MAX_CIPHERTEXT) return { ok: false, code: "TOO_LARGE", message: "That library is too big to sync", status: 413 };
		const now = Date.now();
		const sql = this.sql();
		sql.exec("DELETE FROM writes WHERE at < ?", now - 3_600_000);
		const recent = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM writes").toArray()[0]?.n ?? 0;
		if (recent >= WRITES_PER_HOUR) return { ok: false, code: "RATE_LIMITED", message: "Too many syncs this hour; try again later", status: 429 };
		const r = this.row();
		if (r && r.auth_hash !== authHash) return { ok: false, code: "FORBIDDEN", message: "Wrong sync code", status: 403 };
		const current = r?.version ?? 0;
		if (baseVersion !== current) return { ok: false, code: "CONFLICT", message: "Another device synced first; merge and try again", status: 409, version: current };
		const version = current + 1;
		sql.exec(
			"INSERT INTO vault (k, auth_hash, version, updated, iv, data) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET version = excluded.version, updated = excluded.updated, iv = excluded.iv, data = excluded.data",
			authHash, version, now, iv, data,
		);
		sql.exec("INSERT INTO writes (at) VALUES (?)", now);
		await this.ctx.storage.setAlarm?.(now + IDLE_MS);
		return { ok: true, version, updatedAt: now };
	}

	async erase(authHash: string): Promise<VaultResult> {
		const r = this.row();
		if (!r) return { ok: false, code: "NOT_FOUND", message: "Nothing synced yet", status: 404 };
		if (r.auth_hash !== authHash) return { ok: false, code: "FORBIDDEN", message: "Wrong sync code", status: 403 };
		this.sql().exec("DELETE FROM vault");
		this.sql().exec("DELETE FROM writes");
		return { ok: true, version: 0, updatedAt: Date.now() };
	}

	/** A year without a write: the vault goes. */
	async alarm() {
		const r = this.row();
		if (r && Date.now() - r.updated >= IDLE_MS - 60_000) {
			this.sql().exec("DELETE FROM vault");
			this.sql().exec("DELETE FROM writes");
		}
	}
}
