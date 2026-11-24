// BetterYTS Stream: contracts, ported PearConnect policy rules, media resolution, the queue Durable
// Object (on Node's SQLite) and the /api/stream/v1 routes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { env } from "cloudflare:workers";
import { fakeClock, namespace } from "./support/do.ts";
import { canTransition, parseSongRequestEvent, REQUEST_STATES, type MediaItem, type SongRequestEvent } from "../src/stream/contracts.ts";
import { DEFAULT_POLICY, evaluate, isAllowed, normalizePolicy, parseCommand, precheck, type QueueSnapshot } from "../src/stream/policy.ts";
import { resolveMedia, type ResolverDeps } from "../src/stream/resolve.ts";
import { type Caller, sha256, StreamSession } from "../src/stream/session.ts";
import { streamRoutes } from "../src/stream/routes.ts";

const media = (id: string, extra: Partial<MediaItem> = {}): MediaItem => ({ provider: "youtube", id, title: `Song ${id}`, creator: "Artist", durationSeconds: 200, thumbnail: "", live: false, ...extra });
const snap = (extra: Partial<QueueSnapshot> = {}): QueueSnapshot => ({ now: 1_000_000, lastRequestAt: null, activeForActor: 0, activeTotal: 0, activeMediaIds: new Set(), ...extra });
const viewer = { platformUserId: "viewer1", displayName: "Viewer" };
let seq = 0;
const event = (input: string, platform: SongRequestEvent["source"]["platform"] = "twitch", user = "viewer1"): SongRequestEvent => ({
	schemaVersion: "1",
	eventId: `evt-${++seq}-abcdef`,
	eventType: "song_request.submitted",
	source: { platform },
	actor: { platformUserId: user, displayName: user },
	request: { input, inputType: "text" },
	occurredAt: new Date().toISOString(),
});
const OWNER: Caller = { scope: "owner", tokenId: "owner" };

test("contracts: lifecycle transitions are validated", () => {
	assert.ok(canTransition("received", "resolving"));
	assert.ok(canTransition("queued", "dispatching"));
	assert.equal(canTransition("rejected", "playing"), false, "blueprint §7.2 example");
	assert.equal(canTransition("dispatching", "queued"), false, "a possibly-played request is never requeued");
	for (const s of ["completed", "rejected", "skipped", "failed", "cancelled"] as const) for (const t of REQUEST_STATES) assert.equal(canTransition(s, t), false, `${s} is terminal`);
});

test("contracts: canonical event validation", () => {
	const ok = parseSongRequestEvent({ ...event(" Artist - Song "), actor: { platformUserId: "u1", displayName: "@Name" } });
	assert.equal(ok.request.input, "Artist - Song");
	assert.equal(ok.actor.displayName, "Name");
	assert.throws(() => parseSongRequestEvent({ ...event("x"), extra: 1 }), /unsupported fields/);
	assert.throws(() => parseSongRequestEvent({ ...event("x"), schemaVersion: "2" }), /schemaVersion/);
	assert.throws(() => parseSongRequestEvent({ ...event("x"), source: { platform: "myspace" } }), /platform/);
	assert.throws(() => parseSongRequestEvent({ ...event("%query%") }), /placeholder/);
	assert.throws(() => parseSongRequestEvent({ ...event("a\u0007b") }), /control/);
});

test("policy: PearConnect command syntax and allowlists", () => {
	assert.deepEqual(parseCommand("!sr Daft Punk - One More Time"), { command: "request", query: "Daft Punk - One More Time" });
	assert.deepEqual(parseCommand("!SR  “quoted” ünïcode "), { command: "request", query: "“quoted” ünïcode" });
	assert.equal(parseCommand("sr no bang"), null);
	assert.equal(parseCommand("!unknown x"), null);
	assert.equal(isAllowed("web", viewer, ["viewer"]), false, "website names never satisfy an allowlist");
	assert.equal(isAllowed("twitch", viewer, ["twitch:viewer"]), true);
	assert.equal(isAllowed("youtube", { platformUserId: "UCabc", displayName: "Viewer" }, ["viewer"]), false, "YouTube needs the channel ID");
	assert.equal(isAllowed("youtube", { platformUserId: "UCabc", displayName: "Viewer" }, ["youtube:UCabc"]), true);
});

test("policy: precheck and evaluate keep PearConnect's rules and add capacity, duplicates and approval", () => {
	const p = DEFAULT_POLICY;
	assert.equal((precheck(p, "twitch", viewer, "", snap()) as { code: string }).code, "usage");
	assert.equal((precheck({ ...p, blocklist: ["rick"] }, "twitch", viewer, "Rick Astley", snap()) as { code: string }).code, "blocked");
	const cd = precheck(p, "twitch", viewer, "x", snap({ lastRequestAt: 1_000_000 - 10_000 })) as { code: string; retryAfter: number };
	assert.equal(cd.code, "cooldown");
	assert.equal(cd.retryAfter, 50);
	assert.equal((precheck(p, "twitch", viewer, "x", snap({ activeForActor: 2 })) as { code: string }).code, "user_limit");
	assert.equal((precheck(p, "twitch", viewer, "x", snap({ activeTotal: 50 })) as { code: string }).code, "queue_full");
	assert.equal(precheck(p, "twitch", viewer, "x", snap()), null);

	assert.equal((evaluate(p, viewer, "x", media("a", { durationSeconds: null }), snap()) as { code: string }).code, "unknown_duration");
	assert.equal((evaluate(p, viewer, "x", media("a", { durationSeconds: 999 }), snap()) as { code: string }).code, "too_long");
	assert.equal((evaluate({ ...p, maxSongSeconds: 0 }, viewer, "x", media("a", { durationSeconds: null }), snap()) as { ok: boolean }).ok, true, "0 disables the limit");
	assert.equal((evaluate(p, viewer, "x", media("a", { live: true }), snap()) as { code: string }).code, "live_stream");
	assert.equal((evaluate(p, viewer, "x", media("a"), snap({ activeMediaIds: new Set(["a"]) })) as { code: string }).code, "duplicate");
	assert.equal((evaluate({ ...p, blocklist: ["artist"] }, viewer, "x", media("a"), snap()) as { code: string }).code, "blocked", "title/artist are checked after lookup");
	assert.deepEqual((evaluate(p, viewer, "x", media("a"), snap()) as { state: string }).state, "approved");
	assert.deepEqual((evaluate({ ...p, approvalMode: "manual" }, viewer, "x", media("a"), snap()) as { state: string }).state, "pending_approval");
});

test("policy: updates are validated field by field", () => {
	assert.equal(normalizePolicy({ cooldownSeconds: 0 }).cooldownSeconds, 0);
	assert.deepEqual(normalizePolicy({ blocklist: [" Foo ", "foo", ""] }).blocklist, ["foo"]);
	assert.throws(() => normalizePolicy({ cooldownSeconds: -1 }), /cooldownSeconds/);
	assert.throws(() => normalizePolicy({ surprise: true }), /Unsupported/);
	assert.throws(() => normalizePolicy({ commands: { request: "np" } }), /distinct/);
	assert.throws(() => normalizePolicy({ approvalMode: "yolo" }), /approvalMode/);
	assert.equal(normalizePolicy({ commands: { request: "SongReq" } }).commands.request, "songreq");
});

test("resolve: IDs and links use video details, text uses search, other links are refused", async () => {
	const calls: string[] = [];
	const deps = {
		videoDetails: async (id: string) => (calls.push(`details:${id}`), { id, title: "Linked", author: "Chan", lengthSeconds: 180, isLive: false, thumbnail: "t", playable: "OK" }),
		search: async (q: string) => (calls.push(`search:${q}`), { results: [{ type: "channel" }, { type: "video", id: "bbbbbbbbbbb", title: "Found", channel: { name: "Band" }, durationSeconds: 210, live: false, upcoming: false }] }),
	} as unknown as ResolverDeps;
	const opts = { hl: "en", gl: "US", clientVersion: "x" };
	const a = await resolveMedia("https://youtu.be/dQw4w9WgXcQ", opts, deps);
	assert.equal(a.status === "resolved" && a.media.title, "Linked");
	const b = await resolveMedia("band - found", opts, deps);
	assert.equal(b.status === "resolved" && b.media.id, "bbbbbbbbbbb");
	assert.equal((await resolveMedia("https://www.youtube.com/playlist?list=PL123", opts, deps)).status, "unsupported");
	assert.deepEqual(calls, ["details:dQw4w9WgXcQ", "search:band - found"]);
});

async function session(policy = DEFAULT_POLICY) {
	const ns = namespace(StreamSession);
	const s = ns.getByName("ABCDEFGH");
	await s.create("ABCDEFGH", await sha256("o".repeat(64)), 60, policy);
	return s;
}
const resolved = (id: string, extra: Partial<MediaItem> = {}) => ({ status: "resolved" as const, media: media(id, extra) });

test("queue DO: intake, policy, queue, dispatch, completion and overlay", async () => {
	const clock = fakeClock();
	try {
		const s = await session();
		assert.equal((await s.intake(event("song"))).ok, false, "intake starts paused");
		await s.manage(OWNER, { intake: true });

		const e1 = event("first song");
		const r1 = (await s.intake(e1)) as { id: string; state: string };
		assert.equal(r1.state, "resolving");
		assert.deepEqual(await s.intake(e1), await s.intake(e1), "idempotent on eventId");
		const q1 = (await s.settle(r1.id, resolved("aaaaaaaaaaa"))) as { state: string; ahead: number };
		assert.equal(q1.state, "queued");
		assert.equal(q1.ahead, 0);

		// Same viewer within the cooldown; another viewer asking for the same song.
		assert.equal(((await s.intake(event("again"))) as { code: string }).code, "cooldown");
		const r2 = (await s.intake(event("same", "tiktok", "other"))) as { id: string };
		assert.equal(((await s.settle(r2.id, resolved("aaaaaaaaaaa"))) as { code: string }).code, "duplicate");

		// The destination claims the head of the queue once, and reports the hand-off.
		const claim = s.claim(OWNER, true) as { request: { id: string; media: MediaItem } };
		assert.equal(claim.request.media.id, "aaaaaaaaaaa");
		assert.equal((s.claim(OWNER, true) as { request: unknown }).request, null, "one dispatch at a time, never redelivered");
		const overlay = s.overlay() as { nowPlaying: { title: string; requester: string } };
		assert.equal(overlay.nowPlaying.title, "Song aaaaaaaaaaa");
		assert.equal(JSON.stringify(overlay).includes("first song"), false, "overlay never shows raw input");
		assert.equal((s.report(OWNER, { id: claim.request.id, state: "completed", code: "added" }) as { ok: boolean }).ok, true);
		assert.equal((s.report(OWNER, { id: claim.request.id, state: "playing" }) as { code: string }).code, "invalid_state");
		assert.equal((s.overlay() as { recent: unknown[] }).recent.length, 1);
	} finally {
		clock.restore();
	}
});

test("queue DO: manual approval, moderation, reorder, clear and audit", async () => {
	const clock = fakeClock();
	try {
		const s = await session(normalizePolicy({ approvalMode: "manual", cooldownSeconds: 0 }));
		await s.manage(OWNER, { intake: true });
		const ids: string[] = [];
		for (const [i, user] of ["a", "b", "c"].entries()) {
			const r = (await s.intake(event(`song ${i}`, "twitch", user))) as { id: string };
			assert.equal(((await s.settle(r.id, resolved(`vid${i}xxxxxxx`.slice(0, 11)))) as { state: string }).state, "pending_approval");
			ids.push(r.id);
		}
		const mod: Caller = { scope: "moderator", tokenId: "m1" };
		assert.equal((s.moderate(mod, { action: "approve", id: ids[0] }) as { request: { state: string } }).request.state, "queued");
		assert.equal((s.moderate(mod, { action: "reject", id: ids[1], reason: "off-topic" }) as { request: { state: string } }).request.state, "rejected");
		assert.equal((s.moderate(mod, { action: "approve", id: ids[1] }) as { code: string }).code, "invalid_state", "rejected can't come back");
		s.moderate(mod, { action: "approve", id: ids[2] });
		s.moderate(mod, { action: "reorder", id: ids[2], position: 1 });
		assert.equal(((s.claim(OWNER, true) as { request: { id: string } }).request).id, ids[2], "reordered entry plays first");
		assert.equal((s.moderate(mod, { action: "clear" }) as { code: string }).code, "forbidden", "moderators can't clear");
		assert.equal((s.moderate(OWNER, { action: "clear" }) as { cleared: number }).cleared, 1);
		const q = s.queue(OWNER) as { audit: { action: string; actor: string }[] };
		assert.deepEqual(q.audit.slice(0, 2).map((a) => a.action), ["clear", "reorder"]);
		assert.equal(q.audit[1].actor, "moderator:m1");
	} finally {
		clock.restore();
	}
});

test("queue DO: scoped tokens, expiry, revocation and stuck lookups", async () => {
	const clock = fakeClock();
	try {
		const s = await session();
		const owner = await sha256("o".repeat(64));
		assert.equal(((await s.authorize(owner, "queue.clear")) as Caller).scope, "owner");
		const overlay = (await s.mintToken(OWNER, "overlay", 30, "OBS")) as { token: string; id: string };
		const oh = await sha256(overlay.token);
		assert.equal(((await s.authorize(oh, "overlay.read")) as Caller).scope, "overlay");
		assert.equal(((await s.authorize(oh, "queue.read")) as { code: string }).code, "forbidden", "overlay tokens are read-only");
		s.revokeToken(OWNER, overlay.id);
		assert.equal(((await s.authorize(oh, "overlay.read")) as { code: string }).code, "unauthorized");
		const intake = (await s.mintToken(OWNER, "intake", 5, "bot")) as { token: string };
		clock.advance(6 * 60_000);
		assert.equal(((await s.authorize(await sha256(intake.token), "events.submit")) as { code: string }).code, "unauthorized", "expired");

		await s.manage(OWNER, { intake: true });
		const r = (await s.intake(event("slow"))) as { id: string };
		clock.advance(61_000);
		const q = s.queue(OWNER) as { history: { id: string; state: string }[] };
		assert.equal(q.history.find((h) => h.id === r.id)?.state, "failed", "an abandoned lookup releases its slot");
	} finally {
		clock.restore();
	}
});

test("routes: creation, browser and credential rules, website rejections without upstream calls", async () => {
	const ns = namespace(StreamSession);
	Object.assign(env as object, { STREAM: ns });
	const base = "https://yts.foulfoxhacks.dev";
	const call = (path: string, init: RequestInit = {}) => {
		const req = new Request(base + path, init);
		const url = new URL(req.url);
		return streamRoutes(req, url, url.pathname, { hl: "en", gl: "US", clientVersion: "x" }) as Promise<Response>;
	};
	const json = { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" };

	const browserCreate = await call("/api/stream/v1/sessions", { method: "POST", headers: { ...json, Origin: base }, body: JSON.stringify({ minutes: 60 }) });
	assert.equal(browserCreate.status, 403);
	const res = await call("/api/stream/v1/sessions", { method: "POST", headers: json, body: JSON.stringify({ minutes: 60, policy: { cooldownSeconds: 0 } }) });
	assert.equal(res.status, 201);
	assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
	const created = (await res.json()) as { code: string; ownerToken: string };
	assert.match(created.code, /^[A-HJ-NP-Z2-9]{8}$/);
	const auth = { ...json, Authorization: `Bearer ${created.ownerToken}` };

	assert.equal((await call(`/api/stream/v1/sessions/${created.code}/queue`)).status, 401);
	assert.equal((await call(`/api/stream/v1/sessions/${created.code}/queue`, { headers: { ...auth, Origin: "https://evil.example" } })).status, 403);
	assert.equal((await call(`/api/stream/v1/sessions/${created.code}/manage`, { method: "POST", headers: auth, body: JSON.stringify({ intake: true, policy: { blocklist: ["nope"] } }) })).status, 200);

	const web = (body: object) => call(`/api/stream/v1/sessions/${created.code}/requests`, { method: "POST", headers: { ...json, Origin: base }, body: JSON.stringify(body) });
	assert.equal((await web({ name: "Viewer", query: "x" })).status, 400, "a request ID is required");
	const blocked = (await (await web({ id: crypto.randomUUID(), name: "Viewer", query: "nope nope" })).json()) as { state: string; code: string };
	assert.deepEqual([blocked.state, blocked.code], ["rejected", "blocked"]);

	const minted = (await (await call(`/api/stream/v1/sessions/${created.code}/tokens`, { method: "POST", headers: auth, body: JSON.stringify({ scope: "overlay" }) })).json()) as { token: string; overlayUrl: string };
	assert.ok(minted.overlayUrl.startsWith(`${base}/stream/overlay#${created.code}.`));
	const ov = await call(`/api/stream/v1/sessions/${created.code}/overlay`, { headers: { "X-Overlay-Token": minted.token } });
	assert.equal(ov.status, 200);
	assert.equal((await call(`/api/stream/v1/sessions/${created.code}/overlay`, { headers: { "X-Overlay-Token": "0".repeat(64) } })).status, 401);
	assert.equal((await call(`/api/stream/v1/sessions/${created.code}/overlay?token=${minted.token}`)).status, 400, "credentials are refused in URLs");

	// Oversized bodies are refused, declared or not.
	const big = JSON.stringify({ id: crypto.randomUUID(), name: "x", query: "y".repeat(9000) });
	assert.equal((await call(`/api/stream/v1/sessions/${created.code}/requests`, { method: "POST", headers: { ...json, Origin: base }, body: big })).status, 400);

	// IPv6 addresses in one /64 share the website request limit.
	let limited = 0;
	for (let i = 1; i <= 8; i++) {
		const r = await call(`/api/stream/v1/sessions/${created.code}/requests`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `2001:db8:1:2::${i}`, Origin: base }, body: JSON.stringify({ id: crypto.randomUUID(), name: "V", query: "nope" }) });
		if (r.status === 429) limited++;
	}
	assert.ok(limited >= 2, "rotating addresses inside a /64 does not reset the limit");

	for (let i = 0; i < 4; i++) await call("/api/stream/v1/sessions", { method: "POST", headers: json, body: JSON.stringify({ minutes: 15 }) });
	assert.equal((await call("/api/stream/v1/sessions", { method: "POST", headers: json, body: JSON.stringify({ minutes: 15 }) })).status, 429, "five sessions a minute per connection");
});

test("queue DO: complete action and session counters for the creator console", async () => {
	const clock = fakeClock();
	try {
		const s = await session(normalizePolicy({ cooldownSeconds: 0, blocklist: ["nope"] }));
		await s.manage(OWNER, { intake: true });
		const a = (await s.intake(event("song a", "twitch", "u1"))) as { id: string };
		await s.settle(a.id, resolved("aaaaaaaaaaa"));
		await s.intake(event("nope", "twitch", "u2"));
		const mod: Caller = { scope: "moderator", tokenId: "m1" };
		assert.equal((s.moderate(mod, { action: "complete", id: a.id }) as { request: { state: string } }).request.state, "completed", "DJ marks it played");
		assert.equal((s.moderate(mod, { action: "complete", id: a.id }) as { code: string }).code, "invalid_state");
		const q = s.queue(OWNER) as { stats: Record<string, number> };
		assert.deepEqual(q.stats, { received: 2, accepted: 1, rejected: 1, completed: 1 });
	} finally {
		clock.restore();
	}
});
