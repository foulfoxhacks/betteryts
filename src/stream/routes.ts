// BetterYTS Stream HTTP API: /api/stream/v1/* (blueprint §8). Every response is no-store and noindex,
// and /api/ is already disallowed in robots.txt, so none of this touches the site's search presence.
//
//   POST /api/stream/v1/sessions                                  create (no Origin: desktop/CLI only) → ownerToken
//   GET  /api/stream/v1/sessions/{code}                           public view
//   POST /api/stream/v1/sessions/{code}/requests                  website request {id, name, query}
//   GET  /api/stream/v1/sessions/{code}/requests/{id}             website receipt
//   POST /api/stream/v1/sessions/{code}/events                    canonical event (intake / owner token)
//   GET  /api/stream/v1/sessions/{code}/queue                     queue, history, audit (moderator / owner)
//   POST /api/stream/v1/sessions/{code}/queue/action              approve|reject|remove|skip|reorder|clear
//   POST /api/stream/v1/sessions/{code}/manage                    {intake, policy, minutes, end} (owner)
//   POST /api/stream/v1/sessions/{code}/tokens                    mint scoped token (owner)
//   POST /api/stream/v1/sessions/{code}/tokens/revoke             {id} (owner)
//   POST /api/stream/v1/sessions/{code}/destination/claim         {ready} → next queued request (destination)
//   POST /api/stream/v1/sessions/{code}/destination/report        {id, state, code, message} (destination)
//   GET  /api/stream/v1/sessions/{code}/overlay                   read-only overlay state (X-Overlay-Token header)

import { env } from "cloudflare:workers";

import { InputError, parseSongRequestEvent, type SongRequestEvent } from "./contracts.ts";
import { normalizePolicy } from "./policy.ts";
import { resolveMedia } from "./resolve.ts";
import { type Fail, randomToken, SCOPES, type Scope, sha256, type StreamSession } from "./session.ts";
import type { ClientOptions } from "../lib/types.ts";
import { clientNet } from "../vrc/links-core.ts";

export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 8192;

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

function reply(value: { status?: number } & Record<string, unknown>): Response {
	const { status, ...data } = value;
	return new Response(JSON.stringify(data), { status: typeof status === "number" ? status : 200, headers: HEADERS });
}
const fail = (code: string, message: string, status = 400) => reply({ ok: false, code, message, status });

type Namespace = { getByName(name: string): StreamSession };
function sessions(): Namespace | null {
	return ((env as unknown as { STREAM?: Namespace }).STREAM ?? null) as Namespace | null;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
	if (!req.headers.get("Content-Type")?.startsWith("application/json")) throw new InputError("Send a JSON body (Content-Type: application/json).");
	// Refuse by declared size first, then cap what is actually read (a missing or false length).
	if (Number(req.headers.get("Content-Length") ?? 0) > MAX_BODY) throw new InputError("Body must be smaller than 8 KiB.");
	const reader = req.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_BODY) {
					await reader.cancel();
					throw new InputError("Body must be smaller than 8 KiB.");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.byteLength;
	}
	const raw = new TextDecoder().decode(bytes);
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		throw new InputError("Body is not valid JSON.");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Body must be a JSON object.");
	return body as Record<string, unknown>;
}

function isFail(v: unknown): v is Fail {
	return !!v && typeof v === "object" && (v as { ok?: unknown }).ok === false && typeof (v as { status?: unknown }).status === "number";
}

/** Run the slow media lookup between the two intake phases. Lookup errors fail the request, not the API. */
async function submitAndResolve(stub: StreamSession, event: SongRequestEvent, opts: ClientOptions, extra: { ip?: string; publicWeb?: boolean }) {
	const first = await stub.intake(event, extra);
	if (isFail(first) || first.state !== "resolving") return first;
	let resolution;
	try {
		resolution = await resolveMedia(event.request.input, opts);
	} catch {
		resolution = { status: "error" as const, message: "The song lookup failed. Nothing was queued; try again." };
	}
	return stub.settle(first.id, resolution);
}

export async function streamRoutes(req: Request, url: URL, path: string, opts: ClientOptions): Promise<Response | null> {
	if (!path.startsWith("/api/stream/")) return null;
	const ns = sessions();
	if (!ns) return fail("unavailable", "BetterYTS Stream isn't enabled on this server.", 503);
	const origin = req.headers.get("Origin");
	// Browsers may only call from this site; desktop clients and bots send no Origin.
	if ((origin && origin !== url.origin) || req.headers.get("Sec-Fetch-Site") === "cross-site") return fail("forbidden", "Use the BetterYTS Stream page or an API client.", 403);
	// Limits are per network (IPv6 /64), so rotating addresses inside one allocation does not reset them.
	const ip = clientNet(req.headers.get("CF-Connecting-IP") ?? "unknown");
	const bearer = req.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";

	try {
		if (path === "/api/stream/v1" || path === "/api/stream") {
			return reply({ ok: true, version: "1", docs: `${url.origin}/stream#api` });
		}
		if (path === "/api/stream/v1/sessions") {
			if (req.method !== "POST") return fail("method_not_allowed", "Use POST.", 405);
			if (origin || req.headers.has("Cookie")) return fail("forbidden", "Create sessions from PearConnect Desktop or an API client.", 403);
			const body = await readJson(req);
			const minutes = body.minutes;
			if (!Number.isInteger(minutes) || (minutes as number) < 15 || (minutes as number) > 1440) return fail("invalid_input", "Choose 15 to 1440 minutes.");
			// Per-connection creation throttle: a dedicated object per network, five a minute.
			const throttle = await ns.getByName(`throttle:${ip}`).throttle(5, 60_000);
			if (!throttle) return fail("rate_limited", "Too many new sessions. Wait one minute.", 429);
			const policy = normalizePolicy(body.policy);
			for (let attempt = 0; attempt < 3; attempt++) {
				const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
				const ownerToken = randomToken();
				const created = await ns.getByName(code).create(code, await sha256(ownerToken), minutes as number, policy);
				if (!isFail(created)) return reply({ ...created, ownerToken, status: 201 });
			}
			return fail("busy", "Couldn't create a code. Try again shortly.", 503);
		}

		const m = /^\/api\/stream\/v1\/sessions\/([A-Z0-9]{8})(?:\/(.+))?$/.exec(path);
		if (!m || !CODE_RE.test(m[1])) return fail("not_found", "Unknown Stream endpoint. See /stream#api", 404);
		const stub = ns.getByName(m[1]);
		const rest = m[2] ?? "";
		const method = req.method;
		const auth = async (permission: Parameters<StreamSession["authorize"]>[1]) => {
			if (bearer && origin) return { ok: false, code: "forbidden", message: "Session credentials aren't accepted from browsers yet.", status: 403 } as Fail;
			return stub.authorize(bearer ? await sha256(bearer) : "", permission);
		};

		if (rest === "" && method === "GET") return reply(await stub.publicView());

		if (rest === "requests" && method === "POST") {
			const body = await readJson(req);
			if (typeof body.id !== "string" || !UUID_RE.test(body.id)) return fail("invalid_input", "A request ID (UUID) is required so retries are safe.");
			let event: SongRequestEvent;
			try {
				event = parseSongRequestEvent({
					schemaVersion: "1",
					eventId: body.id,
					eventType: "song_request.submitted",
					source: { platform: "web" },
					actor: { platformUserId: "web", displayName: body.name },
					request: { input: body.query ?? "", inputType: "text" },
					occurredAt: new Date().toISOString(),
				});
			} catch (err) {
				return fail("invalid_input", err instanceof InputError ? err.message : "Invalid request.");
			}
			if (!event.request.input) return fail("invalid_input", "Enter an artist and song, or a YouTube link.");
			return reply(await submitAndResolve(stub, event, opts, { ip, publicWeb: true }));
		}
		const receipt = /^requests\/([0-9a-f-]{36})$/.exec(rest);
		if (receipt && method === "GET") return reply(await stub.lookup(receipt[1], ip));

		if (rest === "events" && method === "POST") {
			const caller = await auth("events.submit");
			if (isFail(caller)) return reply(caller);
			const event = parseSongRequestEvent(await readJson(req));
			return reply(await submitAndResolve(stub, event, opts, {}));
		}
		if (rest === "queue" && method === "GET") {
			const caller = await auth("queue.read");
			return reply(isFail(caller) ? caller : await stub.queue(caller));
		}
		if (rest === "queue/action" && method === "POST") {
			const body = await readJson(req);
			const caller = await auth(body.action === "clear" ? "queue.clear" : "queue.moderate");
			if (isFail(caller)) return reply(caller);
			return reply(await stub.moderate(caller, body as { action: string }));
		}
		if (rest === "manage" && method === "POST") {
			const caller = await auth("session.manage");
			if (isFail(caller)) return reply(caller);
			const body = await readJson(req);
			const unknown = Object.keys(body).filter((k) => !["intake", "policy", "minutes", "end"].includes(k));
			if (unknown.length) return fail("invalid_input", "Supported fields: intake, policy, minutes, end.");
			const current = await stub.currentPolicy();
			const policy = body.policy !== undefined && current ? normalizePolicy(body.policy, current) : undefined;
			return reply(await stub.manage(caller, body, policy));
		}
		if (rest === "tokens" && method === "POST") {
			const caller = await auth("session.manage");
			if (isFail(caller)) return reply(caller);
			const body = await readJson(req);
			const scope = body.scope as Scope;
			if (!SCOPES.includes(scope) || scope === "owner") return fail("invalid_input", "scope must be moderator, intake, destination or overlay.");
			const minutes = body.minutes ?? 1440;
			if (!Number.isInteger(minutes) || (minutes as number) < 5 || (minutes as number) > 10080) return fail("invalid_input", "minutes must be 5 to 10080.");
			const label = typeof body.label === "string" ? body.label : scope;
			const minted = await stub.mintToken(caller, scope, minutes as number, label);
			if (isFail(minted)) return reply(minted);
			const overlayUrl = scope === "overlay" ? `${url.origin}/stream/overlay#${m[1]}.${minted.token}` : undefined;
			return reply({ ...minted, ...(overlayUrl ? { overlayUrl } : {}), status: 201 });
		}
		if (rest === "tokens/revoke" && method === "POST") {
			const caller = await auth("session.manage");
			if (isFail(caller)) return reply(caller);
			const body = await readJson(req);
			if (typeof body.id !== "string" || !/^[0-9a-f]{8}$/.test(body.id)) return fail("invalid_input", "Token id required.");
			return reply(await stub.revokeToken(caller, body.id));
		}
		if (rest === "destination/claim" && method === "POST") {
			const caller = await auth("destination");
			if (isFail(caller)) return reply(caller);
			const body = await readJson(req);
			return reply(await stub.claim(caller, body.ready === true));
		}
		if (rest === "destination/report" && method === "POST") {
			const caller = await auth("destination");
			if (isFail(caller)) return reply(caller);
			return reply(await stub.report(caller, await readJson(req)));
		}
		if (rest === "overlay" && method === "GET") {
			// Header only: a credential in the URL would land in request logs. The overlay page reads it from
			// its #fragment (never sent to the server) and sends it here.
			if (url.searchParams.has("token")) return fail("invalid_input", "Send the overlay token in the X-Overlay-Token header, not the URL.");
			const token = req.headers.get("X-Overlay-Token") ?? "";
			if (!/^[a-f0-9]{64}$/.test(token)) return fail("unauthorized", "Overlay token required.", 401);
			const caller = await stub.authorize(await sha256(token), "overlay.read");
			return reply(isFail(caller) ? caller : await stub.overlay());
		}
		return fail("not_found", "Unknown Stream endpoint or method. See /stream#api", 404);
	} catch (err) {
		if (err instanceof InputError) return fail("invalid_input", err.message);
		console.error(JSON.stringify({ event: "stream_operation_failed", error: err instanceof Error ? err.name : "unknown" }));
		return fail("unavailable", "The Stream service is unavailable. Check the previous result before retrying.", 503);
	}
}
