// BetterYTS Stream: one Durable Object per stream session (named by its 8-character code). It is the
// single authority for that session's request queue: intake, policy, lifecycle, moderation, playback
// hand-off and overlay state all go through here, so two queue engines can never drift apart.
//
// Grown from PearConnect's session-code relay (relay/src/index.ts: StreamSession), keeping its
// guarantees: hashed credentials, a persisted claim before delivery and no automatic redelivery of a
// possibly-played request, per-connection rate limits and short-lived receipts.

import { DurableObject } from "cloudflare:workers";

import { ACTIVE_STATES, actorKey, assertTransition, type MediaItem, type Platform, type ReasonCode, type RequestState, type SongRequestEvent, TERMINAL_STATES } from "./contracts.ts";
import { DEFAULT_POLICY, evaluate, normalizePolicy, precheck, type QueueSnapshot, type RequestPolicy } from "./policy.ts";
import type { Resolution } from "./resolve.ts";

export const MINUTE = 60_000;
/** Finished requests and the session itself stay readable this long for receipts and history. */
export const RETENTION_MS = 60 * MINUTE;
/** A request stuck resolving this long (Worker died mid-lookup) fails instead of holding a slot. */
export const RESOLVE_TIMEOUT_MS = 60_000;
/** A destination that hasn't polled for this long is shown offline (requests still queue). */
export const DESTINATION_STALE_MS = 30_000;
export const WEB_LIMIT_PER_MINUTE = 6;
export const MAX_ROWS = 2000;

export const SCOPES = ["owner", "moderator", "intake", "destination", "overlay"] as const;
export type Scope = (typeof SCOPES)[number];
export type Permission = "queue.read" | "queue.moderate" | "queue.clear" | "session.manage" | "events.submit" | "destination" | "overlay.read";

const GRANTS: Record<Scope, readonly Permission[]> = {
	owner: ["queue.read", "queue.moderate", "queue.clear", "session.manage", "events.submit", "destination", "overlay.read"],
	moderator: ["queue.read", "queue.moderate", "overlay.read"],
	intake: ["events.submit"],
	destination: ["destination"],
	overlay: ["overlay.read"],
};

interface Meta {
	code: string;
	ownerHash: string;
	ipSalt: string;
	created: number;
	expiresAt: number;
	ended: boolean;
	intake: boolean;
	revision: number;
	policy: RequestPolicy;
	destinationSeen: number;
	destinationReady: boolean;
}

type Row = {
	id: string;
	event_id: string;
	fingerprint: string;
	platform: Platform;
	actor_key: string;
	actor_name: string;
	identity: string;
	input: string;
	state: RequestState;
	code: string | null;
	message: string | null;
	media: string | null;
	position: number | null;
	created: number;
	updated: number;
	uncertain: number;
};

export type Fail = { ok: false; code: string; message: string; status: number };
const fail = (code: string, message: string, status = 400): Fail => ({ ok: false, code, message, status });

export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256(value: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, "0")).join("");
}
function sameHash(a: string, b: string): boolean {
	if (a.length !== b.length || !a) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export interface Caller {
	scope: Scope;
	tokenId: string;
}

export class StreamSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = this.ctx.storage.sql;
		for (const stmt of [
			"CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
			"CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, label TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)",
			"CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, platform TEXT NOT NULL, actor_key TEXT NOT NULL, actor_name TEXT NOT NULL, identity TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL, code TEXT, message TEXT, media TEXT, position REAL, created INTEGER NOT NULL, updated INTEGER NOT NULL, uncertain INTEGER NOT NULL DEFAULT 0)",
			"CREATE INDEX IF NOT EXISTS requests_state ON requests(state, position)",
			"CREATE TABLE IF NOT EXISTS actions (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL)",
			"CREATE TABLE IF NOT EXISTS cooldowns (actor_key TEXT PRIMARY KEY, at INTEGER NOT NULL)",
			"CREATE TABLE IF NOT EXISTS limits (identity TEXT PRIMARY KEY, at INTEGER NOT NULL, count INTEGER NOT NULL)",
			// Session totals for the creator console (kept after rows are pruned).
			"CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, n INTEGER NOT NULL)",
		])
			sql.exec(stmt);
	}

	// ---- storage helpers -------------------------------------------------------------------------

	private meta(): Meta | null {
		const row = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM meta WHERE id=1").toArray()[0];
		return row ? (JSON.parse(row.data) as Meta) : null;
	}
	private saveMeta(m: Meta) {
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES(1, ?)", JSON.stringify(m));
	}
	private live(m: Meta | null): m is Meta {
		return !!m && !m.ended && m.expiresAt > Date.now();
	}
	private row(id: string): Row | undefined {
		return this.ctx.storage.sql.exec<Row>("SELECT * FROM requests WHERE id=?", id).toArray()[0];
	}
	private move(row: Row, to: RequestState, fields: { code?: ReasonCode | string | null; message?: string | null; media?: MediaItem | null; position?: number | null; uncertain?: boolean } = {}) {
		assertTransition(row.state, to);
		if (to === "queued") this.count("accepted");
		else if (to === "rejected") this.count("rejected");
		else if (to === "completed") this.count("completed");
		const now = Date.now();
		this.ctx.storage.sql.exec(
			"UPDATE requests SET state=?, code=COALESCE(?, code), message=COALESCE(?, message), media=COALESCE(?, media), position=?, updated=?, uncertain=? WHERE id=? AND state=?",
			to,
			fields.code ?? null,
			fields.message ?? null,
			fields.media ? JSON.stringify(fields.media) : null,
			fields.position !== undefined ? fields.position : TERMINAL_STATES.has(to) ? null : row.position,
			now,
			fields.uncertain ? 1 : row.uncertain,
			row.id,
			row.state,
		);
		// Keep the caller's copy in step with what was written.
		const fresh = this.row(row.id);
		if (fresh) Object.assign(row, fresh);
	}
	private count(key: "received" | "accepted" | "rejected" | "completed") {
		this.ctx.storage.sql.exec("INSERT INTO stats VALUES(?,1) ON CONFLICT(key) DO UPDATE SET n=n+1", key);
	}
	private stats() {
		const out = { received: 0, accepted: 0, rejected: 0, completed: 0 };
		for (const r of this.ctx.storage.sql.exec<{ key: keyof typeof out; n: number }>("SELECT key, n FROM stats").toArray()) if (r.key in out) out[r.key] = r.n;
		return out;
	}
	private audit(requestId: string | null, caller: Caller | string, action: string, reason = "") {
		const actor = typeof caller === "string" ? caller : `${caller.scope}:${caller.tokenId}`;
		this.ctx.storage.sql.exec("INSERT INTO actions (request_id, actor, action, reason, at) VALUES (?,?,?,?,?)", requestId, actor, action, reason.slice(0, 300), Date.now());
	}
	private nextPosition(): number {
		return (this.ctx.storage.sql.exec<{ p: number | null }>("SELECT max(position) AS p FROM requests WHERE position IS NOT NULL").one().p ?? 0) + 1;
	}
	private snapshot(key: string, excludeId = ""): QueueSnapshot {
		const sql = this.ctx.storage.sql;
		const active = [...ACTIVE_STATES];
		const marks = active.map(() => "?").join(",");
		const rows = sql.exec<{ actor_key: string; media: string | null }>(`SELECT actor_key, media FROM requests WHERE state IN (${marks}) AND id != ?`, ...active, excludeId).toArray();
		const ids = new Set<string>();
		for (const r of rows) if (r.media) ids.add((JSON.parse(r.media) as MediaItem).id);
		return {
			now: Date.now(),
			lastRequestAt: sql.exec<{ at: number }>("SELECT at FROM cooldowns WHERE actor_key=?", key).toArray()[0]?.at ?? null,
			activeForActor: rows.filter((r) => r.actor_key === key).length,
			activeTotal: rows.length,
			activeMediaIds: ids,
		};
	}
	private prune() {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		// Work abandoned mid-lookup must not hold a slot forever.
		for (const r of sql.exec<Row>("SELECT * FROM requests WHERE state IN ('received','resolving') AND created < ?", now - RESOLVE_TIMEOUT_MS).toArray()) {
			this.move(r, "failed", { code: "unavailable", message: "The song lookup didn't finish. Nothing was queued." });
		}
		const terminal = [...TERMINAL_STATES];
		sql.exec(`DELETE FROM requests WHERE state IN (${terminal.map(() => "?").join(",")}) AND updated < ?`, ...terminal, now - RETENTION_MS);
		sql.exec("DELETE FROM actions WHERE at < ?", now - 24 * 60 * MINUTE);
		sql.exec("DELETE FROM limits WHERE at < ?", now - MINUTE);
		const policy = this.meta()?.policy ?? DEFAULT_POLICY;
		sql.exec("DELETE FROM cooldowns WHERE at < ?", now - policy.cooldownSeconds * 1000);
	}

	/** Used on objects named "throttle:<ip>" only: true while under `max` hits per window. */
	throttle(max: number, windowMs: number): boolean {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		sql.exec("DELETE FROM limits WHERE at < ?", now - windowMs);
		const row = sql.exec<{ count: number }>("SELECT count FROM limits WHERE identity='create'").toArray()[0];
		if ((row?.count ?? 0) >= max) return false;
		sql.exec("INSERT INTO limits VALUES('create',?,1) ON CONFLICT(identity) DO UPDATE SET count=count+1", now);
		return true;
	}

	// ---- lifecycle -------------------------------------------------------------------------------

	async create(code: string, ownerHash: string, minutes: number, policy: RequestPolicy): Promise<ReturnType<StreamSession["view"]> | Fail> {
		if (this.meta()) return fail("collision", "Try a new session code.", 409);
		const now = Date.now();
		const m: Meta = { code, ownerHash, ipSalt: randomToken(), created: now, expiresAt: now + minutes * MINUTE, ended: false, intake: false, revision: 0, policy, destinationSeen: 0, destinationReady: false };
		this.saveMeta(m);
		this.audit(null, "owner", "session.create");
		await this.ctx.storage.setAlarm?.(m.expiresAt + RETENTION_MS);
		return this.view(m);
	}

	async alarm() {
		const m = this.meta();
		if (m && Date.now() < m.expiresAt + RETENTION_MS) {
			this.prune();
			await this.ctx.storage.setAlarm?.(m.expiresAt + RETENTION_MS);
			return;
		}
		await this.ctx.storage.deleteAll?.();
	}

	/** What anyone holding the code may see: no requester names, no moderation detail. */
	private view(m: Meta) {
		const destinationOnline = m.destinationSeen > Date.now() - DESTINATION_STALE_MS;
		return {
			ok: true as const,
			code: m.code,
			expiresAt: m.expiresAt,
			ended: m.ended || m.expiresAt <= Date.now(),
			accepting: this.live(m) && m.intake,
			destinationOnline,
			destinationReady: destinationOnline && m.destinationReady,
			approvalMode: m.policy.approvalMode,
			command: `!${m.policy.commands.request}`,
			maxSongSeconds: m.policy.maxSongSeconds,
			revision: m.revision,
		};
	}

	publicView() {
		const m = this.meta();
		return this.live(m) ? this.view(m) : fail("session_expired", "This code has ended or expired. Ask the streamer for a new code.", 404);
	}

	/** Resolve a bearer credential to its scope. Owner first, then minted tokens. */
	async authorize(tokenHash: string, permission: Permission): Promise<Caller | Fail> {
		const m = this.meta();
		if (!m || !tokenHash) return fail("unauthorized", "A valid session credential is required.", 401);
		let caller: Caller | null = null;
		if (sameHash(tokenHash, m.ownerHash)) caller = { scope: "owner", tokenId: "owner" };
		else {
			const t = this.ctx.storage.sql.exec<{ id: string; scope: Scope; expires: number; revoked: number }>("SELECT id, scope, expires, revoked FROM tokens WHERE hash=?", tokenHash).toArray()[0];
			if (t && !t.revoked && t.expires > Date.now()) caller = { scope: t.scope, tokenId: t.id };
		}
		if (!caller) return fail("unauthorized", "This credential is invalid, expired or revoked.", 401);
		if (!GRANTS[caller.scope].includes(permission)) return fail("forbidden", "This credential doesn't allow that.", 403);
		return caller;
	}

	// ---- intake: two phases so quota is reserved before the (slow) media lookup ----------------

	/**
	 * Phase 1. Idempotent on eventId. Returns the request in `resolving` when the Worker should look
	 * the song up next, or a final receipt (rejected / earlier result).
	 */
	async intake(event: SongRequestEvent, opts: { ip?: string; publicWeb?: boolean } = {}) {
		this.prune();
		const m = this.meta();
		if (!this.live(m)) return fail("session_expired", "This code has ended or expired. Ask the streamer for a new code.", 404);
		const sql = this.ctx.storage.sql;
		let actor = event.actor;
		let identity = "";
		if (opts.publicWeb) {
			// Website visitors are identified by a salted hash of their connection, never their IP.
			identity = await sha256(`${m.ipSalt}:${opts.ip ?? "unknown"}`);
			actor = { platformUserId: `web-${identity.slice(0, 16)}`, displayName: actor.displayName };
		}
		const fingerprint = JSON.stringify([event.source.platform, actor.platformUserId, event.request.input]);
		const existing = sql.exec<Row>("SELECT * FROM requests WHERE event_id=?", event.eventId).toArray()[0];
		if (existing) {
			return existing.fingerprint === fingerprint && existing.identity === identity ? this.receipt(existing) : fail("idempotency_conflict", "This request ID was already used. Check your previous result.", 409);
		}
		const fresh = this.meta() as Meta; // re-read after the await above
		if (!fresh.intake) return fail("requests_paused", "Song requests are paused. Existing playback continues.", 409);
		if (opts.publicWeb) {
			const rate = sql.exec<{ count: number }>("SELECT count FROM limits WHERE identity=?", identity).toArray()[0];
			if ((rate?.count ?? 0) >= WEB_LIMIT_PER_MINUTE) return fail("rate_limited", "Too many attempts from this connection. Wait one minute.", 429);
			sql.exec("INSERT INTO limits VALUES(?,?,1) ON CONFLICT(identity) DO UPDATE SET count=count+1", identity, Date.now());
		}
		const resolving = sql.exec<{ n: number }>("SELECT count(*) AS n FROM requests WHERE state IN ('received','resolving')").one().n;
		const total = sql.exec<{ n: number }>("SELECT count(*) AS n FROM requests").one().n;
		if (resolving >= 20 || total >= MAX_ROWS) return fail("busy", "This stream is processing several requests. Try again shortly.", 429);

		const key = actorKey(event.source.platform, actor);
		const id = crypto.randomUUID();
		const now = Date.now();
		sql.exec(
			"INSERT INTO requests (id, event_id, fingerprint, platform, actor_key, actor_name, identity, input, state, created, updated) VALUES (?,?,?,?,?,?,?,?, 'received', ?, ?)",
			id,
			event.eventId,
			fingerprint,
			event.source.platform,
			key,
			actor.displayName,
			identity,
			event.request.input,
			now,
			now,
		);
		this.count("received");
		const row = this.row(id) as Row;
		const denied = precheck(fresh.policy, event.source.platform, actor, event.request.input, this.snapshot(key, id));
		if (denied && !denied.ok) {
			this.move(row, "rejected", { code: denied.code, message: denied.message });
			return { ...this.receipt(row), ...(denied.retryAfter ? { retryAfter: denied.retryAfter } : {}) };
		}
		this.move(row, "resolving");
		return this.receipt(row);
	}

	/** Phase 2: apply the lookup result and the policy; auto mode queues straight away. */
	async settle(id: string, resolution: Resolution | { status: "error"; message: string }) {
		const row = this.row(id);
		const m = this.meta();
		if (!row || !m) return fail("not_found", "Unknown request.", 404);
		if (row.state !== "resolving") return this.receipt(row);
		if (resolution.status !== "resolved") {
			const code: ReasonCode = resolution.status === "error" ? "unavailable" : resolution.status;
			this.move(row, resolution.status === "error" ? "failed" : "rejected", { code, message: `@${row.actor_name} ${resolution.message}` });
			return this.receipt(row);
		}
		const actor = { platformUserId: row.actor_key.slice(row.platform.length + 1), displayName: row.actor_name };
		// Rules may have changed and other requests may have landed during the lookup: check again.
		const snap = this.snapshot(row.actor_key, row.id);
		const decision = (!this.live(m) || !m.intake ? { ok: false as const, code: "requests_paused" as const, message: "Song requests were paused while searching. Nothing was queued." } : null) ??
			precheck(m.policy, row.platform, actor, row.input, snap) ??
			evaluate(m.policy, actor, row.input, resolution.media, snap);
		if (!decision.ok) {
			this.move(row, "rejected", { code: decision.code, message: decision.message, media: resolution.media });
			return this.receipt(row);
		}
		this.ctx.storage.sql.exec("INSERT INTO cooldowns VALUES(?,?) ON CONFLICT(actor_key) DO UPDATE SET at=excluded.at", row.actor_key, Date.now());
		this.move(row, decision.state, { code: decision.state === "approved" ? "accepted" : "awaiting_approval", message: decision.message, media: resolution.media, position: this.nextPosition() });
		if (decision.state === "approved") this.move(row, "queued");
		this.bump();
		return this.receipt(row);
	}

	/** Receipt for the website visitor who made the request (matched by their connection hash). */
	async lookup(id: string, ip: string) {
		const m = this.meta();
		const row = this.row(id);
		if (!m || !row || row.identity !== (await sha256(`${m.ipSalt}:${ip}`))) return fail("not_found", "Request receipt unavailable.", 404);
		return this.receipt(row);
	}

	private receipt(row: Row) {
		const media = row.media ? (JSON.parse(row.media) as MediaItem) : null;
		const ahead =
			row.state === "queued" && row.position !== null ? this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM requests WHERE state IN ('queued','dispatching','playing') AND position < ?", row.position).one().n : null;
		return {
			ok: !["rejected", "failed", "cancelled"].includes(row.state),
			id: row.id,
			state: row.state,
			code: row.code,
			message: row.message ?? (row.state === "resolving" ? "Looking up your song." : "Request received."),
			media: media ? { id: media.id, title: media.title, creator: media.creator, durationSeconds: media.durationSeconds } : null,
			ahead,
			outcomeUncertain: row.uncertain === 1,
		};
	}

	private bump() {
		const m = this.meta();
		if (!m) return;
		m.revision++;
		this.saveMeta(m);
	}

	// ---- creator / moderator ---------------------------------------------------------------------

	queue(caller: Caller) {
		void caller;
		this.prune();
		const m = this.meta();
		if (!m) return fail("session_expired", "Session not found.", 404);
		const rows = this.ctx.storage.sql.exec<Row>("SELECT * FROM requests ORDER BY CASE WHEN position IS NULL THEN 1 ELSE 0 END, position, created DESC LIMIT 300").toArray();
		const entry = (r: Row) => ({ ...this.receipt(r), platform: r.platform, requester: r.actor_name, input: r.input, created: r.created, updated: r.updated, position: r.position });
		return {
			...this.view(m),
			intake: m.intake,
			policy: m.policy,
			stats: this.stats(),
			active: rows.filter((r) => ACTIVE_STATES.has(r.state)).map(entry),
			history: rows.filter((r) => TERMINAL_STATES.has(r.state)).sort((a, b) => b.updated - a.updated).slice(0, 100).map(entry),
			audit: this.ctx.storage.sql.exec("SELECT request_id AS requestId, actor, action, reason, at FROM actions ORDER BY seq DESC LIMIT 50").toArray(),
			tokens: this.ctx.storage.sql.exec("SELECT id, scope, label, expires, revoked FROM tokens ORDER BY expires DESC").toArray(),
		};
	}

	moderate(caller: Caller, body: { action: string; id?: string; position?: number; reason?: string }) {
		const m = this.meta();
		if (!this.live(m)) return fail("session_expired", "This session has ended.", 410);
		const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "";
		if (body.action === "clear") {
			if (caller.scope !== "owner") return fail("forbidden", "Only the session owner can clear the queue.", 403);
			const rows = this.ctx.storage.sql.exec<Row>("SELECT * FROM requests WHERE state IN ('pending_approval','approved','queued')").toArray();
			for (const r of rows) this.move(r, "cancelled", { code: "cleared", message: "The queue was cleared." });
			this.audit(null, caller, "clear", reason);
			this.bump();
			return { ok: true, cleared: rows.length };
		}
		const row = typeof body.id === "string" ? this.row(body.id) : undefined;
		if (!row) return fail("not_found", "Unknown request.", 404);
		try {
			switch (body.action) {
				case "approve":
					this.move(row, "approved", { code: "accepted", message: `@${row.actor_name} your request was approved.` });
					this.move(row, "queued");
					break;
				case "reject":
					this.move(row, "rejected", { code: "moderator_rejected", message: `@${row.actor_name} a moderator declined that request.` });
					break;
				case "remove":
					this.move(row, "cancelled", { code: "moderator_removed", message: `@${row.actor_name} a moderator removed that request.` });
					break;
				case "complete":
					this.move(row, "completed", { code: "completed", message: "Marked as played." });
					break;
				case "skip":
					this.move(row, "skipped", { code: "skipped", message: "Skipped by a moderator." });
					break;
				case "reorder": {
					if (row.state !== "queued" && row.state !== "pending_approval") return fail("invalid_state", "Only waiting requests can be moved.", 409);
					if (!Number.isInteger(body.position) || (body.position as number) < 1) return fail("invalid_input", "position must be a whole number from 1.");
					const order = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM requests WHERE state IN ('queued','pending_approval') AND id != ? ORDER BY position", row.id).toArray().map((r) => r.id);
					order.splice(Math.min((body.position as number) - 1, order.length), 0, row.id);
					const base = this.ctx.storage.sql.exec<{ p: number | null }>("SELECT max(position) AS p FROM requests WHERE state IN ('dispatching','playing')").one().p ?? 0;
					order.forEach((id, i) => this.ctx.storage.sql.exec("UPDATE requests SET position=?, updated=? WHERE id=?", base + i + 1, Date.now(), id));
					break;
				}
				default:
					return fail("invalid_input", "action must be approve, reject, remove, complete, skip, reorder or clear.");
			}
		} catch (err) {
			if (err instanceof Error && err.name === "TransitionError") return fail("invalid_state", err.message, 409);
			throw err;
		}
		this.audit(row.id, caller, body.action, reason);
		this.bump();
		return { ok: true, request: this.receipt(this.row(row.id) as Row) };
	}

	async manage(caller: Caller, body: { intake?: unknown; policy?: unknown; minutes?: unknown; end?: unknown }, policy?: RequestPolicy) {
		const m = this.meta();
		if (!this.live(m)) return fail("session_expired", "This session has ended.", 410);
		if (body.minutes !== undefined) {
			if (!Number.isInteger(body.minutes) || (body.minutes as number) < 15 || (body.minutes as number) > 1440) return fail("invalid_input", "Choose an expiration from 15 to 1440 minutes.");
			m.expiresAt = Date.now() + (body.minutes as number) * MINUTE;
			await this.ctx.storage.setAlarm?.(m.expiresAt + RETENTION_MS);
		}
		if (body.intake !== undefined) {
			if (typeof body.intake !== "boolean") return fail("invalid_input", "intake must be true or false.");
			m.intake = body.intake;
		}
		if (policy) m.policy = policy;
		if (body.end === true) Object.assign(m, { ended: true, intake: false, expiresAt: Date.now() });
		m.revision++;
		this.saveMeta(m);
		this.audit(null, caller, body.end === true ? "session.end" : "session.update", Object.keys(body).join(","));
		return { ...this.view(m), intake: m.intake, policy: m.policy };
	}

	currentPolicy(): RequestPolicy | null {
		return this.meta()?.policy ?? null;
	}

	async mintToken(caller: Caller, scope: Scope, minutes: number, label: string) {
		const m = this.meta();
		if (!this.live(m)) return fail("session_expired", "This session has ended.", 410);
		if (scope === "owner") return fail("invalid_input", "Owner credentials can't be minted.");
		const token = randomToken();
		const id = crypto.randomUUID().slice(0, 8);
		// A token never outlives its session.
		const expires = Math.min(Date.now() + minutes * MINUTE, m.expiresAt);
		this.ctx.storage.sql.exec("INSERT INTO tokens (id, hash, scope, label, expires) VALUES (?,?,?,?,?)", id, await sha256(token), scope, label.slice(0, 60), expires);
		this.audit(null, caller, `token.mint.${scope}`, label);
		return { ok: true as const, id, scope, expires, token };
	}

	revokeToken(caller: Caller, id: string) {
		const changed = this.ctx.storage.sql.exec("UPDATE tokens SET revoked=1 WHERE id=? AND revoked=0", id);
		void changed;
		this.audit(null, caller, "token.revoke", id);
		return { ok: true };
	}

	// ---- playback destinations (PearConnect Desktop → Pear Desktop is the first) -------------------

	/**
	 * Heartbeat plus claim: marks the destination online and, when it says it's ready and nothing is
	 * already dispatching, hands over the next queued request. The claim is saved before the response
	 * leaves, and a lost response is never redelivered (the song may already be playing).
	 */
	claim(caller: Caller, ready: boolean) {
		void caller;
		this.prune();
		const m = this.meta();
		if (!this.live(m)) return fail("session_expired", "This session has ended.", 410);
		m.destinationSeen = Date.now();
		m.destinationReady = ready;
		this.saveMeta(m);
		const busy = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM requests WHERE state='dispatching'").one().n;
		const next = ready && !busy ? this.ctx.storage.sql.exec<Row>("SELECT * FROM requests WHERE state='queued' ORDER BY position LIMIT 1").toArray()[0] : undefined;
		if (next) {
			this.move(next, "dispatching");
			this.bump();
		}
		const media = next?.media ? (JSON.parse(next.media) as MediaItem) : null;
		return { ...this.view(m), intake: m.intake, request: next && media ? { id: next.id, requester: next.actor_name, platform: next.platform, input: next.input, media } : null };
	}

	report(caller: Caller, body: { id?: unknown; state?: unknown; code?: unknown; message?: unknown; outcomeUncertain?: unknown }) {
		const row = typeof body.id === "string" ? this.row(body.id) : undefined;
		if (!row) return fail("not_found", "Unknown request.", 404);
		const to = body.state;
		if (to !== "playing" && to !== "completed" && to !== "failed") return fail("invalid_input", "state must be playing, completed or failed.");
		const message = typeof body.message === "string" ? body.message.slice(0, 1200) : null;
		const code = typeof body.code === "string" && /^[a-z_]{1,60}$/.test(body.code) ? body.code : to === "failed" ? "destination_failed" : to;
		try {
			this.move(row, to, { code, message, uncertain: body.outcomeUncertain === true });
		} catch (err) {
			if (err instanceof Error && err.name === "TransitionError") return fail("invalid_state", err.message, 409);
			throw err;
		}
		this.audit(row.id, caller, `destination.${to}`, code);
		this.bump();
		return { ok: true, request: this.receipt(row) };
	}

	// ---- overlays: public, read-only, no moderation detail -----------------------------------------

	overlay() {
		const m = this.meta();
		if (!m) return fail("session_expired", "Session not found.", 404);
		const sql = this.ctx.storage.sql;
		const pick = (r: Row) => {
			const media = r.media ? (JSON.parse(r.media) as MediaItem) : null;
			return media ? { title: media.title, creator: media.creator, durationSeconds: media.durationSeconds, thumbnail: media.thumbnail, requester: r.actor_name, platform: r.platform } : null;
		};
		const current = sql.exec<Row>("SELECT * FROM requests WHERE state IN ('playing','dispatching') ORDER BY updated DESC LIMIT 1").toArray()[0];
		return {
			ok: true as const,
			revision: m.revision,
			accepting: this.live(m) && m.intake,
			command: `!${m.policy.commands.request}`,
			nowPlaying: current ? pick(current) : null,
			upcoming: sql.exec<Row>("SELECT * FROM requests WHERE state='queued' ORDER BY position LIMIT 10").toArray().map(pick).filter(Boolean),
			recent: sql.exec<Row>("SELECT * FROM requests WHERE state='completed' ORDER BY updated DESC LIMIT 5").toArray().map(pick).filter(Boolean),
		};
	}
}
