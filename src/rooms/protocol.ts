// Watch-party room protocol (shared by the Durable Object, the Worker and tests).

export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/; // no I, O, 0, 1
export const MAX_MEMBERS = 50;
export const MAX_QUEUE = 100;
export const MAX_MESSAGE_BYTES = 4096;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sync v2: play/seek/load changes take effect this many ms after the server accepts them, so every
 * member (whatever their latency) starts at the same moment instead of when their message arrives.
 * Old clients treat a future `at` as "now", which is how they behaved before.
 */
export const SYNC_LEAD_MS = 300;

/** Per-connection message budget: a burst, then a steady refill. Over budget, messages are dropped. */
export const RATE_BURST = 30;
export const RATE_PER_SEC = 10;

export interface Bucket {
	tokens: number;
	at: number;
}

/** Token bucket: true if the message may go through (and takes a token). */
export function takeToken(b: Bucket, now: number, burst = RATE_BURST, perSec = RATE_PER_SEC): boolean {
	b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec);
	b.at = now;
	if (b.tokens < 1) return false;
	b.tokens -= 1;
	return true;
}

/** Browser origins allowed to open room sockets. Native apps send no Origin and are allowed. */
export function originAllowed(origin: string | null, self: string): boolean {
	if (!origin) return true;
	if (origin === self || origin === "https://yts.foulfoxhacks.dev") return true;
	return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export interface RoomVideo {
	id: string;
	title: string;
}

export interface RoomState {
	video: RoomVideo | null;
	playing: boolean;
	/** Playback position (seconds) at `at`. */
	position: number;
	/** Epoch ms when `position` was recorded. */
	at: number;
	queue: RoomVideo[];
	/** Host-only mode: only hosts may control playback and the queue. Missing in rooms saved before hosts existed. */
	locked?: boolean;
	/** Bumped on every change so clients can ignore stale updates. */
	rev: number;
}

export type ClientMessage =
	| { t: "hello"; name?: string; key?: string }
	| { t: "lock"; locked: boolean }
	| { t: "load"; video: RoomVideo }
	| { t: "play"; position: number }
	| { t: "pause"; position: number }
	| { t: "seek"; position: number }
	| { t: "next" }
	| { t: "ended"; id: string }
	| { t: "queue_add"; video: RoomVideo }
	| { t: "queue_remove"; index: number }
	| { t: "ping"; c?: number };

export function emptyState(): RoomState {
	return { video: null, playing: false, position: 0, at: Date.now(), queue: [], locked: false, rev: 0 };
}

/** Messages that change playback or the queue. In a locked room only hosts may send them. */
export const CONTROL_MESSAGES: ReadonlySet<string> = new Set(["load", "play", "pause", "seek", "next", "queue_add", "queue_remove"]);

/**
 * Whether a member may send this message. `ended` stays open to everyone: it only advances when the
 * reported video is the current one, and the host may not be the one whose player finished first.
 */
export function mayControl(s: RoomState, m: ClientMessage, isHost: boolean): boolean {
	if (m.t === "lock") return isHost;
	if (s.locked && CONTROL_MESSAGES.has(m.t)) return isHost;
	return true;
}

export const HOST_KEY_RE = /^[A-Za-z0-9_-]{32}$/;

/** Secret that proves who created a room. Returned once by /api/rooms/new and kept in that browser. */
export function newHostKey(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => alphabet[b & 63]).join("");
}

/** Constant-time comparison, so a wrong key can't be guessed one character at a time. */
export function sameKey(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Where playback is right now. */
export function currentPosition(s: RoomState, now = Date.now()): number {
	return s.playing ? s.position + Math.max(0, now - s.at) / 1000 : s.position;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function cleanVideo(v: unknown): RoomVideo | null {
	if (!v || typeof v !== "object") return null;
	const { id, title } = v as { id?: unknown; title?: unknown };
	if (typeof id !== "string" || !VIDEO_ID.test(id)) return null;
	const t = typeof title === "string" ? title.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) : "";
	return { id, title: t || id };
}

const pos = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(n, 60 * 60 * 24)) : 0);

/** Pure state transition: returns the new state, or null if the message changes nothing. */
export function applyMessage(s: RoomState, m: ClientMessage, now = Date.now()): RoomState | null {
	const next = (patch: Partial<RoomState>): RoomState => ({ ...s, ...patch, rev: s.rev + 1 });
	switch (m.t) {
		case "lock": {
			const locked = m.locked === true;
			return locked === !!s.locked ? null : next({ locked });
		}
		case "load": {
			const video = cleanVideo(m.video);
			return video ? next({ video, playing: true, position: 0, at: now + SYNC_LEAD_MS }) : null;
		}
		case "play":
			return s.video ? next({ playing: true, position: pos(m.position), at: now + SYNC_LEAD_MS }) : null;
		case "pause":
			return s.video ? next({ playing: false, position: pos(m.position), at: now }) : null;
		case "seek":
			return s.video ? next({ position: pos(m.position), at: s.playing ? now + SYNC_LEAD_MS : now }) : null;
		case "ended":
			// Several clients report the end; only advance once for the video that's actually current.
			if (!s.video || m.id !== s.video.id) return null;
			return advance(s, now);
		case "next":
			return advance(s, now);
		case "queue_add": {
			const video = cleanVideo(m.video);
			if (!video || s.queue.length >= MAX_QUEUE) return null;
			if (!s.video) return next({ video, playing: true, position: 0, at: now + SYNC_LEAD_MS });
			return next({ queue: [...s.queue, video] });
		}
		case "queue_remove": {
			if (!Number.isInteger(m.index) || m.index < 0 || m.index >= s.queue.length) return null;
			return next({ queue: s.queue.filter((_, i) => i !== m.index) });
		}
		default:
			return null;
	}
}

function advance(s: RoomState, now: number): RoomState {
	const [video, ...queue] = s.queue;
	return { ...s, video: video ?? null, queue, playing: !!video, position: 0, at: video ? now + SYNC_LEAD_MS : now, rev: s.rev + 1 };
}

export function newRoomCode(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
