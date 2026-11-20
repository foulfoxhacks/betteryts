// Watch-party room: one Durable Object per room code. Uses the WebSocket Hibernation API so
// idle rooms cost nothing; state is persisted, and an alarm deletes rooms idle for 24 hours.

import { DurableObject } from "cloudflare:workers";
import {
	applyMessage,
	type ClientMessage,
	currentPosition,
	emptyState,
	HOST_KEY_RE,
	mayControl,
	MAX_MEMBERS,
	MAX_MESSAGE_BYTES,
	ROOM_TTL_MS,
	type RoomState,
	sameKey,
	takeToken,
	type Bucket,
	RATE_BURST,
} from "./protocol.ts";

/** Re-arming the cleanup alarm on every message is a storage write each time; once an hour is plenty. */
const ALARM_REFRESH_MS = 60 * 60 * 1000;

interface Member {
	name: string;
	host: boolean;
}

export class Room extends DurableObject<Env> {
	private state: RoomState = emptyState();
	/** Set once by /api/rooms/new. Rooms opened by code alone (or created before hosts existed) have none. */
	private hostKey: string | null = null;
	/** Per-socket message budgets. In memory only: hibernation resets them, which is harmless. */
	private buckets = new WeakMap<WebSocket, Bucket>();
	private alarmSetAt = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.state = (await ctx.storage.get<RoomState>("state")) ?? emptyState();
			this.hostKey = (await ctx.storage.get<string>("hostKey")) ?? null;
		});
	}

	/** Called by /api/rooms/new right after picking a code. Only the first claim wins. */
	async claim(key: string): Promise<boolean> {
		if (this.hostKey || !HOST_KEY_RE.test(key)) return false;
		this.hostKey = key;
		await this.ctx.storage.put("hostKey", key);
		await this.touch();
		return true;
	}

	/** Snapshot for HTTP readers (e.g. /room/{code} redirects). */
	async snapshot(): Promise<{ state: RoomState; position: number; members: number }> {
		return { state: this.state, position: currentPosition(this.state), members: this.ctx.getWebSockets().length };
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
		if (this.ctx.getWebSockets().length >= MAX_MEMBERS) return new Response("Room is full", { status: 429 });
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ name: "Guest", host: false } satisfies Member);
		await this.touch();
		server.send(this.message());
		this.broadcastMembers();
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) return;
		let msg: ClientMessage;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (!msg || typeof msg !== "object") return;

		// Rate limit every message, pings included: floods are dropped, not queued.
		const now = Date.now();
		let bucket = this.buckets.get(ws);
		if (!bucket) {
			bucket = { tokens: RATE_BURST, at: now };
			this.buckets.set(ws, bucket);
		}
		if (!takeToken(bucket, now)) return;

		if (msg.t === "ping") {
			// Time sync: echo the client's send time (c) and stamp ours (s) as late as possible.
			const c = typeof msg.c === "number" && Number.isFinite(msg.c) ? msg.c : undefined;
			ws.send(JSON.stringify(c === undefined ? { t: "pong" } : { t: "pong", c, s: Date.now() }));
			return;
		}
		if (msg.t === "hello") {
			const name = typeof msg.name === "string" ? msg.name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 32) : "";
			const host = !!this.hostKey && typeof msg.key === "string" && sameKey(msg.key, this.hostKey);
			ws.serializeAttachment({ name: name || "Guest", host } satisfies Member);
			ws.send(JSON.stringify({ t: "you", host, hasHost: !!this.hostKey }));
			this.broadcastMembers();
			return;
		}
		if (!mayControl(this.state, msg, this.member(ws).host)) {
			// Tell the sender, and resend the state so their player snaps back.
			ws.send(JSON.stringify({ t: "denied", reason: msg.t === "lock" ? "not_host" : "locked" }));
			ws.send(this.message());
			return;
		}
		const next = applyMessage(this.state, msg);
		if (!next) return;
		this.state = next;
		// Broadcast first. allowUnconfirmed lets the message leave before the write is durable;
		// the in-memory state is the source of truth while the room is awake, and a lost write
		// only means a room restored after an eviction is one step behind.
		this.broadcast(this.message());
		this.ctx.storage.put("state", next, { allowUnconfirmed: true });
		if (Date.now() - this.alarmSetAt > ALARM_REFRESH_MS) await this.touch();
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		try {
			ws.close(code, "bye");
		} catch {
			/* already closed */
		}
		this.broadcastMembers(ws);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.broadcastMembers(ws);
	}

	async alarm(): Promise<void> {
		if (this.ctx.getWebSockets().length > 0) {
			await this.touch();
			return;
		}
		await this.ctx.storage.deleteAll();
		this.state = emptyState();
	}

	private async touch(): Promise<void> {
		this.alarmSetAt = Date.now();
		await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
	}

	private member(ws: WebSocket): Member {
		const a = ws.deserializeAttachment() as Partial<Member> | null;
		return { name: a?.name ?? "Guest", host: a?.host === true };
	}

	private message(): string {
		return JSON.stringify({ t: "state", state: this.state, serverTime: Date.now() });
	}

	private broadcast(data: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			try {
				ws.send(data);
			} catch {
				/* closing */
			}
		}
	}

	private broadcastMembers(leaving?: WebSocket): void {
		const sockets = this.ctx.getWebSockets().filter((w) => w !== leaving && w.readyState === WebSocket.OPEN);
		const members = sockets.map((ws) => this.member(ws)).slice(0, MAX_MEMBERS);
		const names = members.map((m) => m.name);
		const hosts = members.filter((m) => m.host).map((m) => m.name);
		this.broadcast(JSON.stringify({ t: "members", count: sockets.length, names, hosts }));
	}
}
