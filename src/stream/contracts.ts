// BetterYTS Stream: canonical contracts shared by every audience source, the queue and playback
// destinations. Schema version 1. See docs/stream/architecture.md.
//
// Ported from PearConnect (foulfoxhacks/PearConnect-Song-Requests src/validation.js) where the rules
// already existed, so existing chat, website and Streamer.bot inputs keep the same limits.

export const SCHEMA_VERSION = "1";

/** Audience sources. "local" is an authenticated local operator (PearConnect Desktop / CLI). */
export const PLATFORMS = ["twitch", "youtube", "tiktok", "web", "android", "vrchat", "local"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Request lifecycle (blueprint §7.2). */
export const REQUEST_STATES = [
	"received",
	"resolving",
	"pending_approval",
	"approved",
	"queued",
	"dispatching",
	"playing",
	"completed",
	"rejected",
	"skipped",
	"failed",
	"cancelled",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RequestState> = new Set(["completed", "rejected", "skipped", "failed", "cancelled"]);
/** States that hold a slot in the queue (count toward capacity, duplicates and per-user limits). */
export const ACTIVE_STATES: ReadonlySet<RequestState> = new Set(["received", "resolving", "pending_approval", "approved", "queued", "dispatching", "playing"]);

const TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
	received: ["resolving", "rejected", "cancelled", "failed"],
	resolving: ["pending_approval", "approved", "rejected", "failed", "cancelled"],
	pending_approval: ["approved", "rejected", "cancelled"],
	approved: ["queued", "cancelled"],
	// "completed" straight from queued: a DJ marks a request played without a playback destination.
	queued: ["dispatching", "completed", "skipped", "cancelled"],
	// A lost destination answer never auto-retries (it may already be playing): failed, not queued.
	dispatching: ["playing", "completed", "failed", "skipped"],
	playing: ["completed", "skipped", "failed"],
	completed: [],
	rejected: [],
	skipped: [],
	failed: [],
	cancelled: [],
};

export function canTransition(from: RequestState, to: RequestState): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

export class TransitionError extends Error {
	readonly from: RequestState;
	readonly to: RequestState;
	constructor(from: RequestState, to: RequestState) {
		super(`Request cannot move from ${from} to ${to}.`);
		this.name = "TransitionError";
		this.from = from;
		this.to = to;
	}
}

export function assertTransition(from: RequestState, to: RequestState): void {
	if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** Machine-readable outcome codes. PearConnect's codes are kept verbatim so its replies still map. */
export type ReasonCode =
	| "usage"
	| "invalid_input"
	| "forbidden"
	| "blocked"
	| "cooldown"
	| "user_limit"
	| "queue_full"
	| "duplicate"
	| "no_results"
	| "unavailable"
	| "unsupported"
	| "unknown_duration"
	| "too_long"
	| "live_stream"
	| "requests_paused"
	| "rate_limited"
	| "moderator_rejected"
	| "moderator_removed"
	| "cleared"
	| "destination_failed"
	| "outcome_uncertain"
	| "expired";

export interface SourceRef {
	platform: Platform;
	connectionId?: string;
	channelId?: string;
}

export interface Actor {
	/** Stable ID inside the platform's namespace (YouTube channel ID, Twitch login, hashed web visitor…). */
	platformUserId: string;
	displayName: string;
}

/** blueprint §7.1 */
export interface SongRequestEvent {
	schemaVersion: typeof SCHEMA_VERSION;
	eventId: string;
	eventType: "song_request.submitted";
	source: SourceRef;
	actor: Actor;
	request: { input: string; inputType: "text" | "url" | "id" };
	occurredAt: string;
	correlationId?: string;
}

export interface MediaItem {
	provider: "youtube";
	id: string;
	title: string;
	creator: string;
	durationSeconds: number | null;
	thumbnail: string;
	live: boolean;
}

export class InputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InputError";
	}
}

/** PearConnect's text rule: trimmed, length-bounded, no control characters, no unresolved {placeholders}. */
export function cleanText(value: unknown, name: string, { max = 512, optional = false } = {}): string {
	if (value === undefined && optional) return "";
	if (typeof value !== "string") throw new InputError(`${name} must be a string.`);
	const clean = value.trim();
	if ((!optional && !clean) || clean.length > max || /[\u0000-\u001f\u007f]/u.test(clean)) {
		throw new InputError(`${name} must contain ${optional ? "0" : "1"}-${max} characters without control characters.`);
	}
	// Streamer.bot / TikFinity send "%user%" or "{query}" when a variable isn't wired up.
	if (/^([{%]).+([}%])$/u.test(clean)) throw new InputError(`${name} contains an unresolved placeholder.`);
	return clean;
}

const EVENT_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Validate an untrusted canonical event. Unknown top-level keys are rejected, not ignored. */
export function parseSongRequestEvent(body: unknown): SongRequestEvent {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Event must be a JSON object.");
	const b = body as Record<string, unknown>;
	const allowed = new Set(["schemaVersion", "eventId", "eventType", "source", "actor", "request", "occurredAt", "correlationId"]);
	if (Object.keys(b).some((k) => !allowed.has(k))) throw new InputError("Event has unsupported fields.");
	if (b.schemaVersion !== SCHEMA_VERSION) throw new InputError(`schemaVersion must be "${SCHEMA_VERSION}".`);
	if (b.eventType !== "song_request.submitted") throw new InputError("eventType must be song_request.submitted.");
	if (typeof b.eventId !== "string" || !EVENT_ID.test(b.eventId)) throw new InputError("eventId must be 8-128 URL-safe characters.");
	const source = b.source as Record<string, unknown> | undefined;
	if (!source || typeof source !== "object" || !PLATFORMS.includes(source.platform as Platform)) throw new InputError("source.platform is not supported.");
	const actor = b.actor as Record<string, unknown> | undefined;
	if (!actor || typeof actor !== "object") throw new InputError("actor is required.");
	const request = b.request as Record<string, unknown> | undefined;
	if (!request || typeof request !== "object") throw new InputError("request is required.");
	const inputType = request.inputType ?? "text";
	if (!["text", "url", "id"].includes(inputType as string)) throw new InputError("request.inputType must be text, url or id.");
	const occurredAt = typeof b.occurredAt === "string" && !Number.isNaN(Date.parse(b.occurredAt)) ? b.occurredAt : null;
	if (!occurredAt) throw new InputError("occurredAt must be an ISO timestamp.");
	return {
		schemaVersion: SCHEMA_VERSION,
		eventId: b.eventId,
		eventType: "song_request.submitted",
		source: {
			platform: source.platform as Platform,
			...(source.connectionId !== undefined ? { connectionId: cleanText(source.connectionId, "source.connectionId", { max: 100 }) } : {}),
			...(source.channelId !== undefined ? { channelId: cleanText(source.channelId, "source.channelId", { max: 100 }) } : {}),
		},
		actor: {
			platformUserId: cleanText(actor.platformUserId, "actor.platformUserId", { max: 100 }),
			displayName: cleanText(actor.displayName, "actor.displayName", { max: 100 }).replace(/^@/, "") || "viewer",
		},
		// An empty input is allowed on purpose: the policy answers with usage help.
		request: { input: cleanText(request.input ?? "", "request.input", { optional: true }), inputType: inputType as "text" | "url" | "id" },
		occurredAt,
		...(b.correlationId !== undefined ? { correlationId: cleanText(b.correlationId, "correlationId", { max: 128 }) } : {}),
	};
}

/** The key per-user limits are counted under. YouTube display names aren't unique, so IDs only. */
export function actorKey(platform: Platform, actor: Actor): string {
	return `${platform}:${actor.platformUserId.toLowerCase()}`;
}
