// VRChat URL pool (protocol v1, see docs/vrchat-protocol.md).
//
// Worlds bake https://yts.foulfoxhacks.dev/vrc/p/0 … /vrc/p/{POOL_SIZE-1} at edit time, because
// Udon can't build URLs at runtime. This Durable Object hands out those slots on a ring and
// remembers what each one points at: a video, a thumbnail sheet, or a next page of results.

import { DurableObject } from "cloudflare:workers";

import { POOL_SIZE, type SlotEntry, type SlotKind } from "./protocol.ts";

export { POOL_SIZE, type SlotEntry, type SlotKind };

export class VrcPool extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(
			"CREATE TABLE IF NOT EXISTS slots (slot INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, at INTEGER NOT NULL)",
		);
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
	}

	/** Returns one slot per entry, reusing existing slots for keys already in the ring. */
	assign(entries: SlotEntry[]): number[] {
		return this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			const meta = this.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'next'").toArray()[0];
			let next = meta ? meta.v : 0;
			const out: number[] = [];
			for (const e of entries) {
				const existing = this.sql.exec<{ slot: number }>("SELECT slot FROM slots WHERE key = ?", e.key).toArray()[0];
				if (existing) {
					this.sql.exec("UPDATE slots SET payload = ?, at = ? WHERE slot = ?", e.payload, now, existing.slot);
					out.push(existing.slot);
					continue;
				}
				const slot = next;
				next = (next + 1) % POOL_SIZE;
				// REPLACE evicts whatever previously held this slot (the oldest entry on the ring).
				this.sql.exec(
					"INSERT OR REPLACE INTO slots (slot, kind, key, payload, at) VALUES (?, ?, ?, ?, ?)",
					slot,
					e.kind,
					e.key,
					e.payload,
					now,
				);
				out.push(slot);
			}
			this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('next', ?)", next);
			return out;
		});
	}

	lookup(slot: number): (SlotEntry & { at: number }) | null {
		const row = this.sql
			.exec<{ kind: SlotKind; key: string; payload: string; at: number }>("SELECT kind, key, payload, at FROM slots WHERE slot = ?", slot)
			.toArray()[0];
		return row ? { kind: row.kind, key: row.key, payload: row.payload, at: row.at } : null;
	}

	stats(): { used: number; next: number; size: number } {
		const used = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM slots").toArray()[0]?.n ?? 0;
		const next = this.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'next'").toArray()[0]?.v ?? 0;
		return { used, next, size: POOL_SIZE };
	}
}
