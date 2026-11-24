// BetterYTS Stream: chat command parsing and the request policy engine.
//
// Rules are ported from PearConnect's QueueManager (src/queue-manager.js) and commands.js, keeping the
// same defaults, limits and reply wording, and extended with the blueprint's queue capacity,
// duplicate detection and approval modes. Everything here is pure: the queue Durable Object supplies
// the counters, so the same rules can be unit-tested and reused by other hosts.

import { actorKey, type Actor, InputError, type MediaItem, type Platform, type ReasonCode } from "./contracts.ts";

export interface Commands {
	request: string;
	nowPlaying: string;
	queue: string;
	skip: string;
}
export const DEFAULT_COMMANDS: Commands = { request: "sr", nowPlaying: "np", queue: "queue", skip: "skip" };

/** `!sr Artist - Song` → { command: "request", query }. Quoted text and Unicode are preserved. */
export function parseCommand(message: unknown, commands: Commands = DEFAULT_COMMANDS): { command: keyof Commands; query: string } | null {
	if (typeof message !== "string" || message.length > 1024) return null;
	const match = message.trim().match(/^!([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
	if (!match) return null;
	const name = match[1].toLowerCase();
	const command = (Object.keys(commands) as (keyof Commands)[]).find((key) => commands[key] === name);
	return command ? { command, query: (match[2] || "").trim() } : null;
}

/**
 * Allowlist entries are `name` or `platform:name`; YouTube entries must be `youtube:<channel id>`.
 * Anonymous website names can never satisfy an allowlist.
 */
export function isAllowed(platform: Platform, actor: Actor, allowlist: readonly string[]): boolean {
	if (platform === "web") return false;
	const user = actor.displayName.toLowerCase();
	return allowlist.some((entry) => {
		if (platform === "youtube") return entry === `youtube:${actor.platformUserId}`;
		const value = entry.toLowerCase();
		return value === user || value === `${platform}:${user}` || value === `${platform}:${actor.platformUserId.toLowerCase()}`;
	});
}

export type ApprovalMode = "auto" | "manual";

export interface RequestPolicy {
	/** auto: approved requests go straight to the queue. manual: a moderator approves each one. */
	approvalMode: ApprovalMode;
	cooldownSeconds: number;
	/** Requests one viewer may have active (not yet finished) at once. 0 = unlimited. */
	maxPerUser: number;
	/** 0 = no limit. When set, a request whose length can't be verified is refused (PearConnect rule). */
	maxSongSeconds: number;
	/** Active entries the queue holds. 0 = unlimited. */
	maxQueueLength: number;
	/** Refuse a song that is already waiting or playing. */
	rejectDuplicates: boolean;
	allowLive: boolean;
	blocklist: string[];
	/** Empty = everyone may request. */
	requestAllowlist: string[];
	commands: Commands;
}

export const DEFAULT_POLICY: RequestPolicy = {
	approvalMode: "auto",
	cooldownSeconds: 60,
	maxPerUser: 2,
	maxSongSeconds: 420,
	maxQueueLength: 50,
	rejectDuplicates: true,
	allowLive: false,
	blocklist: [],
	requestAllowlist: [],
	commands: DEFAULT_COMMANDS,
};

const POLICY_KEYS = new Set(Object.keys(DEFAULT_POLICY));

function int(value: unknown, name: string, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new InputError(`${name} must be an integer between 0 and ${max}.`);
	return value;
}

function list(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.length > 200 || value.some((v) => typeof v !== "string" || v.length > 200)) throw new InputError(`${name} must be a list of up to 200 short strings.`);
	return [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
}
const lowerList = (value: unknown, name: string) => [...new Set(list(value, name).map((v) => v.toLowerCase()))];

/** Merge a partial, untrusted update over `base`, validating every field (PearConnect config.js ranges). */
export function normalizePolicy(update: unknown, base: RequestPolicy = DEFAULT_POLICY): RequestPolicy {
	if (update === undefined || update === null) return structuredClone(base);
	if (typeof update !== "object" || Array.isArray(update)) throw new InputError("Policy must be a JSON object.");
	const u = update as Record<string, unknown>;
	const unknown = Object.keys(u).filter((k) => !POLICY_KEYS.has(k));
	if (unknown.length) throw new InputError(`Unsupported policy fields: ${unknown.slice(0, 5).join(", ")}.`);
	const next = structuredClone(base);
	if (u.approvalMode !== undefined) {
		if (u.approvalMode !== "auto" && u.approvalMode !== "manual") throw new InputError("approvalMode must be auto or manual.");
		next.approvalMode = u.approvalMode;
	}
	if (u.cooldownSeconds !== undefined) next.cooldownSeconds = int(u.cooldownSeconds, "cooldownSeconds", 86400);
	if (u.maxPerUser !== undefined) next.maxPerUser = int(u.maxPerUser, "maxPerUser", 1000);
	if (u.maxSongSeconds !== undefined) next.maxSongSeconds = int(u.maxSongSeconds, "maxSongSeconds", 604800);
	if (u.maxQueueLength !== undefined) next.maxQueueLength = int(u.maxQueueLength, "maxQueueLength", 500);
	for (const key of ["rejectDuplicates", "allowLive"] as const) {
		if (u[key] !== undefined) {
			if (typeof u[key] !== "boolean") throw new InputError(`${key} must be true or false.`);
			next[key] = u[key];
		}
	}
	if (u.blocklist !== undefined) next.blocklist = lowerList(u.blocklist, "blocklist");
	if (u.requestAllowlist !== undefined) next.requestAllowlist = list(u.requestAllowlist, "requestAllowlist");
	if (u.commands !== undefined) {
		const c = u.commands as Record<string, unknown>;
		if (!c || typeof c !== "object" || Array.isArray(c)) throw new InputError("commands must be an object.");
		const merged = { ...next.commands } as Record<string, string>;
		for (const [key, value] of Object.entries(c)) {
			if (!(key in DEFAULT_COMMANDS)) throw new InputError(`Unknown command ${key}.`);
			if (typeof value !== "string" || !/^[a-z0-9_-]{1,32}$/.test(value.trim().toLowerCase())) throw new InputError(`commands.${key} must be 1-32 letters, digits, underscores or hyphens, without !.`);
			merged[key] = value.trim().toLowerCase();
		}
		if (new Set(Object.values(merged)).size !== 4) throw new InputError("Command names must be distinct.");
		next.commands = merged as unknown as Commands;
	}
	return next;
}

/** What the queue knows about a requester and itself when a request arrives. */
export interface QueueSnapshot {
	now: number;
	lastRequestAt: number | null;
	activeForActor: number;
	activeTotal: number;
	activeMediaIds: ReadonlySet<string>;
}

export type Decision = { ok: true; state: "approved" | "pending_approval"; message: string } | { ok: false; code: ReasonCode; message: string; retryAfter?: number };

const deny = (code: ReasonCode, message: string, extra: { retryAfter?: number } = {}): Decision => ({ ok: false, code, message, ...extra });

function blocked(policy: RequestPolicy, value: string): boolean {
	const v = value.toLowerCase();
	return policy.blocklist.some((b) => v.includes(b));
}

export function formatDuration(seconds: number): string {
	const sec = Math.max(0, Math.floor(seconds));
	return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Checks that don't need the media lookup: run them first so spam never costs an upstream search. */
export function precheck(policy: RequestPolicy, platform: Platform, actor: Actor, input: string, q: QueueSnapshot): Decision | null {
	const user = actor.displayName;
	if (!input) return deny("usage", `@${user} usage: !${policy.commands.request} <song name>`);
	if (policy.requestAllowlist.length && !isAllowed(platform, actor, policy.requestAllowlist)) return deny("forbidden", `@${user} song requests are limited to allowed users.`);
	if (blocked(policy, input)) return deny("blocked", `@${user} that request was blocked.`);
	if (policy.cooldownSeconds > 0 && q.lastRequestAt !== null) {
		const remaining = Math.ceil((policy.cooldownSeconds * 1000 - (q.now - q.lastRequestAt)) / 1000);
		if (remaining > 0) return deny("cooldown", `@${user} slow down - try again in ${remaining}s.`, { retryAfter: remaining });
	}
	if (policy.maxPerUser > 0 && q.activeForActor >= policy.maxPerUser) return deny("user_limit", `@${user} you already have ${policy.maxPerUser} request(s) in the queue. Try again later.`);
	if (policy.maxQueueLength > 0 && q.activeTotal >= policy.maxQueueLength) return deny("queue_full", `@${user} the request queue is full. Try again later.`);
	return null;
}

/** Checks on the resolved media, then the approval decision. */
export function evaluate(policy: RequestPolicy, actor: Actor, input: string, media: MediaItem, q: QueueSnapshot): Decision {
	const user = actor.displayName;
	if (blocked(policy, input) || blocked(policy, `${media.title} ${media.creator}`)) return deny("blocked", `@${user} that request was blocked.`);
	if (media.live && !policy.allowLive) return deny("live_stream", `@${user} live streams can't be requested.`);
	if (policy.maxSongSeconds > 0 && (media.durationSeconds === null || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0)) {
		return deny("unknown_duration", `@${user} no song was added: the length of “${media.title}” couldn't be verified. Try a more specific artist and song name.`);
	}
	if (policy.maxSongSeconds > 0 && (media.durationSeconds as number) > policy.maxSongSeconds) {
		return deny("too_long", `@${user} "${media.title}" is too long (max ${formatDuration(policy.maxSongSeconds)}).`);
	}
	if (policy.rejectDuplicates && q.activeMediaIds.has(media.id)) return deny("duplicate", `@${user} “${media.title}” is already in the queue.`);
	return policy.approvalMode === "manual"
		? { ok: true, state: "pending_approval", message: `@${user} “${media.title}” is waiting for a moderator.` }
		: { ok: true, state: "approved", message: `@${user} added: ${media.title} - ${media.creator}${media.durationSeconds ? ` (${formatDuration(media.durationSeconds)})` : ""}.` };
}

export { actorKey };
