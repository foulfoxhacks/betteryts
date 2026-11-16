// Watch-party room protocol (shared by the Durable Object, the Worker and tests).

export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/; // no I, O, 0, 1
export const MAX_MEMBERS = 50;
export const MAX_QUEUE = 100;
export const MAX_MESSAGE_BYTES = 4096;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

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
	/** Bumped on every change so clients can ignore stale updates. */
	rev: number;
}

export type ClientMessage =
	| { t: "hello"; name?: string }
	| { t: "load"; video: RoomVideo }
	| { t: "play"; position: number }
	| { t: "pause"; position: number }
	| { t: "seek"; position: number }
	| { t: "next" }
	| { t: "ended"; id: string }
	| { t: "queue_add"; video: RoomVideo }
	| { t: "queue_remove"; index: number }
	| { t: "ping" };

export function emptyState(): RoomState {
	return { video: null, playing: false, position: 0, at: Date.now(), queue: [], rev: 0 };
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
		case "load": {
			const video = cleanVideo(m.video);
			return video ? next({ video, playing: true, position: 0, at: now }) : null;
		}
		case "play":
			return s.video ? next({ playing: true, position: pos(m.position), at: now }) : null;
		case "pause":
			return s.video ? next({ playing: false, position: pos(m.position), at: now }) : null;
		case "seek":
			return s.video ? next({ position: pos(m.position), at: now }) : null;
		case "ended":
			// Several clients report the end; only advance once for the video that's actually current.
			if (!s.video || m.id !== s.video.id) return null;
			return advance(s, now);
		case "next":
			return advance(s, now);
		case "queue_add": {
			const video = cleanVideo(m.video);
			if (!video || s.queue.length >= MAX_QUEUE) return null;
			if (!s.video) return next({ video, playing: true, position: 0, at: now });
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
	return { ...s, video: video ?? null, queue, playing: !!video, position: 0, at: now, rev: s.rev + 1 };
}

export function newRoomCode(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
