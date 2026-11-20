// Routes for in-world linking (linking v2; see links-core.ts for the flow and privacy notes).

import { CORS_HEADERS, json, redirect } from "../lib/http.ts";
import { cleanLibrary, formatKey, KEY_SPACE, LINK_SERVICES, LINK_VERSION, type LinkLibrary, type LinkService, libraryTrackIds, normalizeCode, parseKey, renderLibrary } from "./links-core.ts";
import type { VrcLinks } from "./links.ts";
import type { VrcPool } from "./pool.ts";
import { originAllowed } from "../rooms/protocol.ts";

const links = (env: Env) => (env as unknown as { VRC_LINKS: DurableObjectNamespace<VrcLinks> }).VRC_LINKS.getByName("links-v1");
const pool = (env: Env) => (env.VRC_POOL as unknown as DurableObjectNamespace<VrcPool>).getByName("pool-v1");
const noStore = (body: unknown, status = 200) => json(body, status, 0);
/** /vrc/* answers errors with HTTP 200 so worlds can always read the JSON. */
const vrcFail = (error: string) => noStore({ v: LINK_VERSION, ok: false, error });
const siteFail = (error: string, status = 400) => noStore({ v: LINK_VERSION, ok: false, error }, status);
const ipOf = (req: Request) => req.headers.get("CF-Connecting-IP") ?? "unknown";

/** Video slots for every song, so the world can play them (Udon can't build URLs). */
async function slotsFor(env: Env, lib: LinkLibrary): Promise<number[]> {
	const ids = libraryTrackIds(lib);
	return ids.length ? pool(env).assign(ids.map((id) => ({ kind: "video", key: `v:${id}`, payload: id }))) : [];
}

const isService = (s: string): s is LinkService => (LINK_SERVICES as readonly string[]).includes(s);

/**
 * Site POSTs must be JSON and, from browsers, come from this site: a third-party page can't send
 * a "simple" (preflight-free) text/plain form. Apps send no Origin and are allowed.
 */
function postAllowed(req: Request, url: URL): string | null {
	if (!(req.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return "Send JSON (Content-Type: application/json)";
	const origin = req.headers.get("Origin");
	if (origin && !originAllowed(origin, url.origin)) return "Origin not allowed";
	return null;
}

/** Handles /vrc/link/*, /vrc/l/*, /vrc/k/*, /vrc/forget, /api/inworld/* and /inworld/*; null if not ours. */
export async function linkRoutes(req: Request, url: URL, env: Env): Promise<Response | null> {
	const path = url.pathname;
	const ip = ipOf(req);

	// World: get an activation code and the pool slot to poll.
	const start = /^\/vrc\/link\/start\/([a-z]+)$/.exec(path);
	if (start) {
		if (!isService(start[1])) return vrcFail("Unknown service");
		const l = links(env);
		if (!(await l.limit(ip, "start", 30, 3_600_000))) return vrcFail("Too many codes from here; try again later");
		const { code, expiresIn } = await l.start(start[1]);
		const [poll] = await pool(env).assign([{ kind: "link", key: `l:${code}`, payload: code }]);
		return noStore({ v: LINK_VERSION, ok: true, service: start[1], code, url: `${url.host}/inworld/${start[1]}/auth`, expiresIn, poll });
	}

	// World: saved library, step 1 of 2 (first half of the key).
	const a = /^\/vrc\/l\/(\d{1,4})$/.exec(path);
	if (a) {
		const l = links(env);
		if (Number(a[1]) >= KEY_SPACE) return vrcFail("No such key");
		if (!(await l.limit(ip, "load", 120, 3_600_000))) return vrcFail("Too many requests; try again later");
		await l.stepA(ip, Number(a[1]));
		return noStore({ v: LINK_VERSION, ok: true, status: "next" });
	}

	// World: saved library, step 2 of 2 (second half): the library, with a new key to save.
	const b = /^\/vrc\/k\/(\d{1,4})$/.exec(path);
	if (b) {
		const l = links(env);
		if (Number(b[1]) >= KEY_SPACE) return vrcFail("No such key");
		if (!(await l.limit(ip, "load", 120, 3_600_000))) return vrcFail("Too many requests; try again later");
		const got = await l.stepB(ip, Number(b[1]));
		if (got === "locked") return vrcFail("Too many wrong keys from here; try again in an hour");
		if (got === "no-step") return vrcFail("Load /vrc/l/{a} first (within a minute)");
		if (got === "missing") return noStore({ v: LINK_VERSION, ok: true, status: "missing" });
		return noStore(renderLibrary(got.lib, await slotsFor(env, got.lib), got.key, got.expiresAt));
	}

	// World: delete the library this caller linked or loaded in the last minute (Unlink).
	if (path === "/vrc/forget") {
		const l = links(env);
		if (!(await l.limit(ip, "forget", 30, 3_600_000))) return vrcFail("Too many requests; try again later");
		return noStore({ v: LINK_VERSION, ok: true, status: (await l.forgetRecent(ip)) ? "forgotten" : "nothing" });
	}

	// Site: is this code real (and for which service)? Counts toward the guessing limit.
	if (path === "/api/inworld/check") {
		const code = normalizeCode(url.searchParams.get("code"));
		const l = links(env);
		if (!(await l.limit(ip, "enter", 20, 600_000))) return siteFail("Too many tries; wait a few minutes", 429);
		const d = code ? await l.device(code) : null;
		if (!d) return siteFail("That code expired or doesn't exist. Get a new one in the world.", 404);
		if (d.lib !== null) return siteFail("That code was already used", 409);
		return noStore({ ok: true, code: d.code, service: d.service });
	}

	// Site: send the chosen playlists to the world waiting on this code.
	if (path === "/api/inworld/complete") {
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
		if (req.method !== "POST") return siteFail("Method not allowed", 405);
		const bad = postAllowed(req, url);
		if (bad) return siteFail(bad, 403);
		const l = links(env);
		if (!(await l.limit(ip, "enter", 20, 600_000))) return siteFail("Too many tries; wait a few minutes", 429);
		const body = (await req.json().catch(() => null)) as { code?: unknown; service?: unknown; library?: unknown; save?: unknown } | null;
		const code = normalizeCode(body?.code);
		const service = typeof body?.service === "string" && isService(body.service) ? body.service : null;
		if (!code || !service) return siteFail("Expected { code, service, library, save }");
		let clean: LinkLibrary;
		try {
			clean = cleanLibrary(body?.library, service);
		} catch (err) {
			return siteFail((err as Error).message);
		}
		const r = await l.complete(code, clean, body?.save === true);
		return "ok" in r ? noStore({ ok: true, saved: body?.save === true, playlists: clean.playlists.length, tracks: libraryTrackIds(clean).length }) : siteFail(r.error, r.status);
	}

	// Site: see (export) or delete a saved library by the key the world shows.
	if (path === "/api/inworld/library") {
		if (req.method !== "POST") return siteFail("Method not allowed", 405);
		const bad = postAllowed(req, url);
		if (bad) return siteFail(bad, 403);
		const l = links(env);
		if (!(await l.limit(ip, "manage", 30, 600_000))) return siteFail("Too many tries; wait a few minutes", 429);
		const body = (await req.json().catch(() => null)) as { key?: unknown; action?: unknown } | null;
		const key = parseKey(body?.key);
		const action = body?.action === "delete" ? "delete" : body?.action === "view" ? "view" : null;
		if (!key || !action) return siteFail('Expected { key: "1234-5678", action: "view" | "delete" }');
		const r = await l.byKey(ip, key, action);
		if (r === "locked") return siteFail("Too many wrong keys; try again in an hour", 429);
		if (r === "missing") return siteFail("No saved library has that key (it may have expired, been deleted, or changed since the world last loaded it)", 404);
		if (r === "deleted") return noStore({ ok: true, deleted: formatKey(key) });
		return noStore({ ok: true, key: formatKey(key), savedAt: new Date(r.created).toISOString(), expiresAt: new Date(r.created + 30 * 86_400_000).toISOString(), library: r.lib });
	}

	// People: the page that takes the code (front-end view).
	const page = /^\/inworld\/([a-z]+)\/auth\/?$/.exec(path);
	if (page && isService(page[1])) {
		const code = normalizeCode(url.searchParams.get("code"));
		return redirect(`/?view=link&service=${page[1]}${code ? `&code=${code}` : ""}`, 0);
	}
	if (path === "/inworld" || path === "/link") return redirect("/?view=link", 0);
	return null;
}

/** A pool slot of kind "link": what the world sees while it waits for the player. */
export async function linkSlot(code: string, env: Env, ip: string): Promise<Response> {
	const l = links(env);
	const d = await l.device(code);
	if (!d) return noStore({ v: LINK_VERSION, ok: true, status: "expired" });
	if (d.lib === null) return noStore({ v: LINK_VERSION, ok: true, status: "waiting", code: d.code });
	const got = await l.delivered(code, ip);
	if (!got) return noStore({ v: LINK_VERSION, ok: true, status: "expired" });
	return noStore(renderLibrary(got.lib, await slotsFor(env, got.lib), got.key, got.expiresAt));
}
