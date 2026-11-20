// Routes for in-world account linking (see links.ts for the flow and its security notes).

import { CORS_HEADERS, json, redirect } from "../lib/http.ts";
import { cleanLibrary, LIBRARY_SLOTS, LINK_SERVICES, type LinkLibrary, type LinkService, libraryTrackIds, normalizeCode, renderLibrary } from "./links-core.ts";
import type { VrcLinks } from "./links.ts";
import type { VrcPool } from "./pool.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const links = (env: Env) => ((env as unknown as { VRC_LINKS: DurableObjectNamespace<VrcLinks> }).VRC_LINKS).getByName("links-v1");
const pool = (env: Env) => (env.VRC_POOL as unknown as DurableObjectNamespace<VrcPool>).getByName("pool-v1");
const noStore = (body: unknown, status = 200) => json(body, status, 0);
const fail = (error: string, status = 400) => noStore({ v: PROTOCOL_VERSION, ok: false, error }, status);

/** Rate-limit buckets use a hash of the IP (never the IP itself). */
async function ipBucket(req: Request, scope: string): Promise<string> {
	const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`betteryts-link:${scope}:${ip}`));
	return btoa(String.fromCharCode(...new Uint8Array(d).slice(0, 12)));
}

/** Video slots for every song, so the world can play them (Udon can't build URLs). */
async function slotsFor(env: Env, lib: LinkLibrary): Promise<number[]> {
	const ids = libraryTrackIds(lib);
	return ids.length ? pool(env).assign(ids.map((id) => ({ kind: "video", key: `v:${id}`, payload: id }))) : [];
}

const isService = (s: string): s is LinkService => (LINK_SERVICES as readonly string[]).includes(s);

/** Handles /vrc/link/*, /vrc/l/{n}, /api/inworld/* and /inworld/*; null if the path isn't ours. */
export async function linkRoutes(req: Request, url: URL, env: Env): Promise<Response | null> {
	const path = url.pathname;

	// World: get an activation code and the pool slot to poll.
	const start = /^\/vrc\/link\/start\/([a-z]+)$/.exec(path);
	if (start) {
		if (!isService(start[1])) return fail("Unknown service");
		const l = links(env);
		if (!(await l.limit(await ipBucket(req, "start"), 30, 3_600_000))) return fail("Too many codes from here; try again later", 429);
		const { code, expiresIn } = await l.start(start[1]);
		const [poll] = await pool(env).assign([{ kind: "link", key: `l:${code}`, payload: code }]);
		return noStore({ v: PROTOCOL_VERSION, ok: true, service: start[1], code, url: `${url.host}/inworld/${start[1]}/auth`, expiresIn, poll });
	}

	// World: load a saved library by the number kept in PlayerData.
	const lib = /^\/vrc\/l\/(\d{1,5})$/.exec(path);
	if (lib) {
		const n = Number(lib[1]);
		if (n >= LIBRARY_SLOTS) return fail("No such library", 404);
		const l = links(env);
		if (!(await l.limit(await ipBucket(req, "load"), 60, 3_600_000))) return fail("Too many requests; try again later", 429);
		const got = await l.load(n);
		if (!got) return noStore({ v: PROTOCOL_VERSION, ok: true, status: "missing" });
		return noStore({ ok: true, ...renderLibrary(got.lib, await slotsFor(env, got.lib), got.next) });
	}

	// Site: is this code real (and for which service)? Counts toward the guessing limit.
	if (path === "/api/inworld/check") {
		const code = normalizeCode(url.searchParams.get("code"));
		const l = links(env);
		if (!(await l.limit(await ipBucket(req, "enter"), 20, 600_000))) return fail("Too many tries; wait a few minutes", 429);
		const d = code ? await l.device(code) : null;
		if (!d) return fail("That code expired or doesn't exist. Get a new one in the world.", 404);
		if (d.library !== null) return fail("That code was already used", 409);
		return noStore({ ok: true, code: d.code, service: d.service });
	}

	// Site: send the chosen playlists to the world waiting on this code.
	if (path === "/api/inworld/complete") {
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
		if (req.method !== "POST") return fail("Method not allowed", 405);
		const l = links(env);
		if (!(await l.limit(await ipBucket(req, "enter"), 20, 600_000))) return fail("Too many tries; wait a few minutes", 429);
		const body = (await req.json().catch(() => null)) as { code?: unknown; service?: unknown; library?: unknown } | null;
		const code = normalizeCode(body?.code);
		const service = typeof body?.service === "string" && isService(body.service) ? body.service : null;
		if (!code || !service) return fail("Expected { code, service, library }");
		let clean: LinkLibrary;
		try {
			clean = cleanLibrary(body?.library, service);
		} catch (err) {
			return fail((err as Error).message);
		}
		const r = await l.complete(code, clean);
		return "ok" in r ? noStore({ ok: true, playlists: clean.playlists.length, tracks: libraryTrackIds(clean).length }) : fail(r.error, r.status);
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
export async function linkSlot(code: string, env: Env): Promise<Response> {
	const d = await links(env).device(code);
	if (!d) return noStore({ v: PROTOCOL_VERSION, ok: true, status: "expired" });
	if (d.library === null) return noStore({ v: PROTOCOL_VERSION, ok: true, status: "waiting", code: d.code });
	const lib = await links(env).library(d.library);
	if (!lib) return noStore({ v: PROTOCOL_VERSION, ok: true, status: "expired" });
	return noStore({ ok: true, ...renderLibrary(lib, await slotsFor(env, lib), d.library) });
}
