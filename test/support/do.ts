// Durable Object test doubles: SQL storage backed by Node's built-in SQLite (node:sqlite), a
// namespace whose getByName() returns one in-process instance per name, and a controllable clock.
import { DatabaseSync } from "node:sqlite";

type Param = string | number | bigint | null | Uint8Array;

/** The subset of Workers' SqlStorage the app uses: exec(sql, ...params).toArray() / iteration. */
export function sqlStorage() {
	const db = new DatabaseSync(":memory:");
	return {
		db,
		exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
			const st = db.prepare(sql);
			const args = params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p)) as Param[];
			const rows = (st.columns().length ? st.all(...args) : (st.run(...args), [])) as T[];
			return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator](), one: () => rows[0] };
		},
	};
}

export function doState() {
	const sql = sqlStorage();
	const kv = new Map<string, unknown>();
	return {
		storage: {
			sql,
			transactionSync<T>(fn: () => T): T {
				sql.db.exec("BEGIN");
				try {
					const r = fn();
					sql.db.exec("COMMIT");
					return r;
				} catch (err) {
					sql.db.exec("ROLLBACK");
					throw err;
				}
			},
			get: async (k: string) => kv.get(k),
			put: async (k: string, v: unknown) => void kv.set(k, v),
		},
	};
}

/** A namespace binding: getByName(name) → the same instance of `Cls` for that name. */
export function namespace<T>(Cls: new (ctx: never, env: never) => T, env: object = {}) {
	const objects = new Map<string, T>();
	return {
		objects,
		getByName(name: string): T {
			if (!objects.has(name)) objects.set(name, new Cls(doState() as never, env as never));
			return objects.get(name) as T;
		},
	};
}

/** Replaces Date.now() until restore() is called. */
export function fakeClock(start = Date.UTC(2026, 10, 21, 12, 0, 0)) {
	const real = Date.now;
	let now = start;
	Date.now = () => now;
	return {
		advance(ms: number) {
			now += ms;
		},
		set(ms: number) {
			now = ms;
		},
		restore() {
			Date.now = real;
		},
	};
}
