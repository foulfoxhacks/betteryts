// Routes for in-world linking (linking v2; see links-core.ts for the flow and privacy notes).

import { CORS_HEADERS, json, redirect } from "../lib/http.ts";
import { cleanLibrary, formatKey, KEY_SPACE, LINK_SERVICES, LINK_VERSION, type LinkLibrary, type LinkService, libraryTrackIds, normalizeCode, parseKey, renderLibrary } from "./links-core.ts";
import type { VrcLinks } from "./links.ts";
import type { VrcPool } from "./pool.ts";
import { originAllowed } from "../rooms/protocol.ts";
import { exchangeCode, fetchUser, fetchVideos, newState, revokeToken, sameSitePost, TIKTOK_CALLBACK, TikTokError, tiktokAuthorizeUrl, tiktokCodePage, tiktokConfig, tiktokDonePage, tiktokErrorPage, tiktokLibrary, tiktokSandbox, validState } from "../lib/tiktok.ts";

const TT_COOKIE = "__Host-tt_state";
const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
	new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			// Server-rendered pages (TikTok linking): no scripts, forms only back to this site.
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; form-action 'self' https://www.tiktok.com; base-uri 'none'; frame-ancestors 'none'",
			"X-Robots-Tag": "noindex",
			...extra,
		},
	});
const cookieOf = (req: Request, name: string) =>
	(req.headers.get("Cookie") ?? "")
		.split(";")
		.map((c) => c.trim())
		.find((c) => c.startsWith(`${name}=`))
		?.slice(name.length + 1) ?? null;
const clearTtCookie = `${TT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

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
		const { code, expiresIn } = await l.start(start[1], ip);
		const [poll] = await pool(env).assign([{ kind: "link", key: `l:${code}`, payload: code }]);
		// TikTok signs in on a server page (/inworld/tiktok); the others use the site's link view.
		const page = start[1] === "tiktok" ? "/inworld/tiktok" : `/inworld/${start[1]}/auth`;
		return noStore({ v: LINK_VERSION, ok: true, service: start[1], code, url: `${url.host}${page}`, expiresIn, poll });
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

	// ---- TikTok (src/lib/tiktok.ts): server-side sign-in, token revoked after the import ----
	if (path === "/inworld/tiktok" || path === "/inworld/tiktok/" || path === "/inworld/tiktok/auth") {
		return html(tiktokCodePage(normalizeCode(url.searchParams.get("code")) ?? "", "", !!tiktokConfig(env), tiktokSandbox(env)));
	}
	if (path === "/tt/start") return tiktokStart(req, url, env, ip);
	if (path === TIKTOK_CALLBACK) return tiktokCallback(req, url, env, ip);

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
	// Only the caller that asked for the code sees it (slots are public and numbered).
	const d = await l.poll(code, ip);
	if (!d) return noStore({ v: LINK_VERSION, ok: true, status: "expired" });
	if (d.lib === null) return noStore({ v: LINK_VERSION, ok: true, status: "waiting", code: d.code });
	const got = await l.delivered(code, ip);
	if (!got) return noStore({ v: LINK_VERSION, ok: true, status: "expired" });
	return noStore(renderLibrary(got.lib, await slotsFor(env, got.lib), got.key, got.expiresAt));
}

/** POST /tt/start (the form on /inworld/tiktok): check the code, then off to TikTok's consent page. */
async function tiktokStart(req: Request, url: URL, env: Env, ip: string): Promise<Response> {
	if (req.method !== "POST") return redirect("/inworld/tiktok", 0);
	const cfg = tiktokConfig(env);
	if (!cfg) return html(tiktokCodePage("", "", false), 503);
	if (!sameSitePost(req.headers.get("Origin"), req.headers.get("Sec-Fetch-Site"), url.origin))
		return html(tiktokErrorPage("Please start from this site's TikTok linking page."), 403);
	const formData = await req.formData().catch(() => null);
	const raw = formData?.get("code");
	const code = normalizeCode(typeof raw === "string" ? raw : null);
	const save = formData?.get("save") === "1";
	if (!code) return html(tiktokCodePage(typeof raw === "string" ? raw.slice(0, 12) : "", "Enter the 8-character code shown in the world.", true, tiktokSandbox(env)), 400);
	const l = links(env);
	if (!(await l.limit(ip, "enter", 20, 600_000))) return html(tiktokCodePage(code, "Too many tries; wait a few minutes.", true, tiktokSandbox(env)), 429);
	const state = newState();
	const r = await l.ttBegin(state, code, save);
	if ("error" in r) return html(tiktokCodePage(code, r.error, true, tiktokSandbox(env)), 400);
	// The state is also kept in a cookie so the callback must come back to the same browser.
	return new Response(null, {
		status: 302,
		headers: {
			Location: tiktokAuthorizeUrl(url.origin, cfg.clientKey, state),
			"Set-Cookie": `${TT_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

/** GET /tt/callback: check state, exchange the code, read profile + public videos, revoke, link. */
async function tiktokCallback(req: Request, url: URL, env: Env, ip: string): Promise<Response> {
	const fail = (msg: string, status = 400) => html(tiktokErrorPage(msg), status, { "Set-Cookie": clearTtCookie });
	const cfg = tiktokConfig(env);
	if (!cfg) return fail("TikTok linking isn't set up on this server yet.", 503);
	const l = links(env);
	if (!(await l.limit(ip, "enter", 20, 600_000))) return fail("Too many tries; wait a few minutes.", 429);
	const state = url.searchParams.get("state");
	const cookie = cookieOf(req, TT_COOKIE);
	if (!validState(state) || cookie !== state) return fail("This sign-in didn't start in this browser, or it took too long. Start again from the page with your code.");
	const pending = await l.ttTake(state);
	if (!pending) return fail("This sign-in expired or was already used. Get a new code in the world.");
	if (url.searchParams.get("error")) return fail(url.searchParams.get("error") === "access_denied" ? "You cancelled the TikTok sign-in, so nothing was sent." : "TikTok didn't complete the sign-in, so nothing was sent.");
	const code = url.searchParams.get("code");
	if (!code || code.length > 2048) return fail("TikTok didn't send a sign-in code.");
	let token: string | null = null;
	try {
		token = await exchangeCode(cfg, url.origin, code);
		const user = await fetchUser(token);
		const videos = await fetchVideos(token);
		const r = await l.complete(pending.code, tiktokLibrary(user, videos), pending.save);
		if (!("ok" in r)) return fail(r.error, r.status);
		return html(tiktokDonePage(user, videos, pending.save), 200, { "Set-Cookie": clearTtCookie });
	} catch (err) {
		// Never log the code, token or secret; the message is TikTok's or ours.
		return fail(err instanceof TikTokError ? err.message : "Couldn't reach TikTok. Try again in a moment.", 502);
	} finally {
		if (token) await revokeToken(cfg, token);
	}
}
