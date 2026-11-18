// BetterYTS by FoulFoxHacks — ad-free YouTube search API + VRChat-friendly redirects.
//
//   /search?q=…        VRChat / media players → 302 to the top video. Browsers → results page.
//   /lucky?q=…         Always 302 to the top video (aliases: /go, /play).
//   /<anything>        u2b.cx-style: yts.foulfoxhacks.dev/lofi hip hop → 302 to the top video.
//   /v/<id>            302 to a video by ID.
//   /api/*             JSON API (see /docs or GET /api).

import { env } from "cloudflare:workers";
import { branding, dislikes, sponsorSegments, SB_CATEGORIES, suggestions } from "./lib/addons.ts";
import { cached, CORS_HEADERS, errorJson, json, redirect, text } from "./lib/http.ts";
import { FEATURES, search, UpstreamError, videoDetails } from "./lib/innertube.ts";
import {
	boolParam,
	intParam,
	isVideoId,
	queryFromPath,
	queryFromSearchParams,
	videoIdFromQuery,
} from "./lib/query.ts";
import { CHANNEL_TABS, channel, type ChannelTab, channelRefFrom, playlist, playlistIdFrom } from "./lib/browse.ts";
import { appRedirect, authorizeUrl, CALLBACK_PATH, googleConfig, googleToken, validToken, validTokenRequest } from "./lib/google.ts";
import { toProTVPlaylist } from "./lib/protv.ts";
import { frontPageMeta, rewriteFrontPage } from "./lib/seo.ts";
import { vrcInfo, vrcSearch, vrcSlot } from "./vrc/handlers.ts";

export { VrcPool } from "./vrc/pool.ts";
export { Room } from "./rooms/room.ts";

import { currentPosition, newHostKey, newRoomCode, ROOM_CODE_RE } from "./rooms/protocol.ts";
import type { Room } from "./rooms/room.ts";

function roomStub(code: string) {
	return (env.ROOMS as unknown as DurableObjectNamespace<Room>).getByName(code);
}

/** /api/rooms/new, /api/rooms/{code}, /api/rooms/{code}/ws */
async function apiRooms(req: Request, path: string): Promise<Response> {
	if (path === "/api/rooms/new") {
		// The creator gets a host key: with it they can switch the room to host-only control.
		for (let i = 0; i < 3; i++) {
			const code = newRoomCode();
			const hostKey = newHostKey();
			if (await roomStub(code).claim(hostKey)) return json({ code, hostKey });
		}
		return errorJson("Couldn't create a room, try again", 503);
	}
	const m = /^\/api\/rooms\/([A-Za-z0-9]{6})(\/ws)?$/.exec(path);
	if (!m) return errorJson("Unknown room endpoint", 404);
	const code = m[1].toUpperCase();
	if (!ROOM_CODE_RE.test(code)) return errorJson("Invalid room code", 400);
	const stub = roomStub(code);
	if (m[2]) {
		if (req.headers.get("Upgrade") !== "websocket") return errorJson("Expected a WebSocket upgrade", 426);
		return stub.fetch(req);
	}
	const snap = await stub.snapshot();
	return json({ code, ...snap });
}

/** /room/{code}: VRChat & media players → 302 to what's playing now; browsers → the room page. */
async function roomFollow(req: Request, code: string, url: URL): Promise<Response> {
	code = code.toUpperCase();
	if (!ROOM_CODE_RE.test(code)) return text("BetterYTS: invalid room code\n", 404);
	if (isBrowserNavigation(req)) return redirect(`/?room=${code}`, 0);
	const { state } = await roomStub(code).snapshot();
	if (!state.video) return text("BetterYTS: nothing is playing in this room yet\n", 404);
	const t = Math.floor(currentPosition(state));
	return redirect(`https://www.youtube.com/watch?v=${state.video.id}${t > 5 ? `&t=${t}s` : ""}`, 0);
}
import type { ClientOptions, Item, SearchFilters, VideoItem } from "./lib/types.ts";

const VERSION = "1.0.0";

function clientOptions(url: URL): ClientOptions {
	const hl = (url.searchParams.get("hl") || env.DEFAULT_HL || "en").slice(0, 10);
	const gl = (url.searchParams.get("gl") || env.DEFAULT_GL || "US").slice(0, 2).toUpperCase();
	return { hl, gl, clientVersion: env.YT_CLIENT_VERSION || "2.20251114.01.00" };
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
	return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function filtersFromUrl(url: URL, forceType?: SearchFilters["type"]): SearchFilters {
	const p = url.searchParams;
	const features = (p.get("features") ?? "")
		.toLowerCase()
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s in FEATURES);
	return {
		type: forceType ?? pick(p.get("type"), ["all", "video", "channel", "playlist", "movie"] as const) ?? "all",
		sort: pick(p.get("sort"), ["relevance", "rating", "date", "views"] as const),
		duration: pick(p.get("duration"), ["short", "medium", "long"] as const),
		upload: pick(p.get("upload"), ["hour", "today", "week", "month", "year"] as const),
		features,
	};
}

/** Real browsers send Sec-Fetch-Dest: document on top-level navigations; yt-dlp / AVPro / Unity don't. */
function isBrowserNavigation(req: Request): boolean {
	const ua = req.headers.get("User-Agent") ?? "";
	if (/yt-dlp|youtube-dl|UnityPlayer|AVPro|stagefright|NSPlayer|ExoPlayer|VRChat|libmpv|VLC|curl|Wget/i.test(ua)) return false;
	return req.headers.get("Sec-Fetch-Dest") === "document" && req.headers.has("Sec-Fetch-Site");
}

const isVideo = (i: Item): i is VideoItem => i.type === "video" || i.type === "short";

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

async function apiSearch(url: URL, ctx: ExecutionContext): Promise<Response> {
	const q = queryFromSearchParams(url);
	const page = url.searchParams.get("page") || undefined;
	if (!q && !page) return errorJson("Missing search query. Use /api/search?q=your+search", 400);
	if (page && page.length > 4096) return errorJson("Invalid page token", 400);

	const filters = filtersFromUrl(url);
	const opts = clientOptions(url);
	const includeShorts = boolParam(url, "shorts", true);
	const includeShelves = boolParam(url, "shelves", false);
	const withDeArrow = boolParam(url, "dearrow", false);

	const key = `search?${new URLSearchParams({
		q,
		page: page ?? "",
		f: JSON.stringify(filters),
		hl: opts.hl,
		gl: opts.gl,
		s: `${+includeShorts}${+includeShelves}${+withDeArrow}`,
	})}`;

	return cached(key, ctx, async () => {
		const r = await search(q, filters, opts, page);
		let shortsRemoved = 0;
		let shelvesRemoved = 0;
		const results = r.results.filter((item) => {
			if (!includeShelves && item.shelf) {
				shelvesRemoved++;
				return false;
			}
			if (!includeShorts && isVideo(item) && item.isShort) {
				shortsRemoved++;
				return false;
			}
			return true;
		});
		if (withDeArrow) {
			const vids = results.filter(isVideo).slice(0, 25);
			const brands = await Promise.allSettled(vids.map((v) => branding(v.id)));
			vids.forEach((v, i) => {
				const b = brands[i];
				v.branding = b.status === "fulfilled" ? b.value : null;
			});
		}
		return json(
			{
				query: q,
				correctedQuery: r.correctedQuery,
				filters,
				estimatedResults: r.estimatedResults,
				count: results.length,
				results,
				next: r.next,
				blocked: { ads: r.blocked.ads, shorts: shortsRemoved, shelfItems: shelvesRemoved },
				source: r.source,
			},
			200,
			page ? 1800 : 600,
		);
	});
}

/** Shared by /search, /lucky and the u2b-style catch-all. */
async function luckyRedirect(q: string, url: URL, ctx: ExecutionContext): Promise<Response> {
	if (!q) return text("BetterYTS: add a search, e.g. /search?q=lofi+hip+hop\n", 400);
	const target = url.searchParams.get("to") ?? "watch";
	const directId = videoIdFromQuery(q);
	if (directId) return redirect(videoUrl(directId, target), 3600);

	const n = intParam(url, "n", 1, 1, 20);
	const allowShorts = boolParam(url, "shorts", false);
	const allowLive = boolParam(url, "live", true);
	const minLen = intParam(url, "minlen", 0, 0, 86400);
	const maxLen = intParam(url, "maxlen", 0, 0, 86400);
	const filters = filtersFromUrl(url, "video");
	const opts = clientOptions(url);

	const key = `lucky?${new URLSearchParams({ q, f: JSON.stringify(filters), hl: opts.hl, gl: opts.gl, o: `${n}|${+allowShorts}|${+allowLive}|${minLen}|${maxLen}` })}`;
	const res = await cached(key, ctx, async () => {
		const r = await search(q, filters, opts);
		const candidates = r.results.filter(isVideo).filter((v) => {
			if (v.shelf) return false;
			if (v.upcoming) return false;
			if (v.isShort && !allowShorts) return false;
			if (v.live && !allowLive) return false;
			if (minLen && (v.durationSeconds ?? 0) < minLen) return false;
			if (maxLen && v.durationSeconds !== null && v.durationSeconds > maxLen) return false;
			return true;
		});
		const hit = candidates[n - 1];
		if (!hit) return json({ id: null }, 200, 120);
		return json({ id: hit.id, title: hit.title }, 200, 600);
	});
	const data = (await res.json()) as { id: string | null };
	if (!data.id) return text(`BetterYTS: no results for "${q}"\n`, 404);
	return redirect(videoUrl(data.id, target));
}

function videoUrl(id: string, target: string): string {
	switch (target) {
		case "short":
		case "youtu.be":
			return `https://youtu.be/${id}`;
		case "embed":
		case "nocookie":
			return `https://www.youtube-nocookie.com/embed/${id}`;
		case "music":
			return `https://music.youtube.com/watch?v=${id}`;
		case "page":
			return `/?v=${id}`;
		default:
			return `https://www.youtube.com/watch?v=${id}`;
	}
}

async function apiVideo(id: string, url: URL, ctx: ExecutionContext): Promise<Response> {
	const opts = clientOptions(url);
	return cached(`video/${id}?hl=${opts.hl}&gl=${opts.gl}`, ctx, async () => {
		const [details, segments, votes, brand] = await Promise.allSettled([
			videoDetails(id, opts),
			sponsorSegments(id),
			dislikes(id),
			branding(id),
		]);
		if (details.status === "rejected") {
			const err = details.reason;
			return errorJson(err instanceof Error ? err.message : "Lookup failed", err instanceof UpstreamError ? err.status : 502);
		}
		const value = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
		return json(
			{
				...details.value,
				url: `https://www.youtube.com/watch?v=${id}`,
				embed: `https://www.youtube-nocookie.com/embed/${id}`,
				sponsorblock: value(segments) ?? [],
				votes: value(votes),
				dearrow: value(brand),
			},
			200,
			900,
		);
	});
}

async function apiBrandingBatch(url: URL, ctx: ExecutionContext): Promise<Response> {
	const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()))].filter(isVideoId).slice(0, 30);
	if (!ids.length) return errorJson("Pass ?ids=ID1,ID2 (up to 30 video IDs)", 400);
	return cached(`branding?ids=${ids.sort().join(",")}`, ctx, async () => {
		const settled = await Promise.allSettled(ids.map((id) => branding(id)));
		const out: Record<string, unknown> = {};
		ids.forEach((id, i) => {
			const r = settled[i];
			out[id] = r.status === "fulfilled" ? r.value : null;
		});
		return json(out, 200, 900);
	});
}

async function apiPlaylist(id: string, url: URL, ctx: ExecutionContext): Promise<Response> {
	const listId = playlistIdFrom(id);
	if (!listId) return errorJson("Invalid playlist ID", 400);
	const page = url.searchParams.get("page") || undefined;
	if (page && page.length > 4096) return errorJson("Invalid page token", 400);
	const opts = clientOptions(url);
	return cached(`playlist/${listId}?${opts.hl}|${opts.gl}|${page ?? ""}`, ctx, async () => json(await playlist(listId, opts, page), 200, page ? 1800 : 900));
}

async function apiChannel(ref: string, url: URL, ctx: ExecutionContext): Promise<Response> {
	const channelRef = channelRefFrom(ref);
	if (!channelRef) return errorJson("Use a channel ID (UC…) or @handle", 400);
	const tabParam = url.searchParams.get("tab") ?? "videos";
	const tab = (tabParam in CHANNEL_TABS ? tabParam : "videos") as ChannelTab;
	const page = url.searchParams.get("page") || undefined;
	if (page && page.length > 4096) return errorJson("Invalid page token", 400);
	const opts = clientOptions(url);
	return cached(`channel/${channelRef}/${tab}?${opts.hl}|${opts.gl}|${page ?? ""}`, ctx, async () => json(await channel(channelRef, tab, opts, page), 200, page ? 1800 : 900));
}

/** ProTV tokenized playlist from a YouTube search (?q=) or playlist (?list=). */
async function vrcProTVPlaylist(url: URL, ctx: ExecutionContext): Promise<Response> {
	const n = intParam(url, "n", 50, 1, 500);
	const listId = url.searchParams.get("list") ? playlistIdFrom(url.searchParams.get("list") ?? "") : null;
	const q = listId ? "" : queryFromSearchParams(url);
	if (!listId && !q) return text("BetterYTS: add ?q=your+search or ?list=PLAYLIST_ID\n", 400);
	const opts = clientOptions(url);
	return cached(`protv?${listId ?? q}|${n}|${opts.hl}|${opts.gl}`, ctx, async () => {
		const videos: VideoItem[] = [];
		let header = "";
		let next: string | undefined;
		for (let pageNo = 0; pageNo < 10 && videos.length < n; pageNo++) {
			if (listId) {
				const p = await playlist(listId, opts, next);
				if (!header) header = p.title ?? "YouTube playlist";
				videos.push(...p.results.filter(isVideo).filter((v) => !v.upcoming));
				next = p.next ?? undefined;
			} else {
				const r = await search(q, { type: "video" }, opts, next);
				if (!header) header = `BetterYTS: ${q}`;
				videos.push(...r.results.filter(isVideo).filter((v) => !v.isShort && !v.upcoming && !v.shelf));
				next = r.next ?? undefined;
			}
			if (!next) break;
		}
		const seen = new Set<string>();
		const unique = videos.filter((v) => !seen.has(v.id) && seen.add(v.id)).slice(0, n);
		return new Response(toProTVPlaylist(header, unique), {
			headers: {
				...CORS_HEADERS,
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Disposition": 'inline; filename="betteryts.playlist"',
				"Cache-Control": "public, max-age=3600, s-maxage=3600",
			},
		});
	});
}

function apiIndex(origin: string): Response {
	return json(
		{
			name: "BetterYTS by FoulFoxHacks",
			version: VERSION,
			docs: `${origin}/docs`,
			source: "https://github.com/foulfoxhacks/betteryts",
			endpoints: {
				"GET /search?q=": "VRChat & media players: 302 to the top video. Browsers: results page.",
				"GET /lucky?q=": "Always 302 to the top video. Options: n, shorts, live, minlen, maxlen, sort, duration, upload, to",
				"GET /<query>": "u2b.cx-style shortcut for /lucky",
				"GET /v/{id}": "302 to a video by ID (to=watch|youtu.be|embed|music)",
				"GET /api/search?q=": "Ad-free JSON results. Options: type, sort, duration, upload, features, shorts, shelves, dearrow, page, hl, gl",
				"GET /api/suggest?q=": "Search autocomplete",
				"GET /api/video/{id}": "Video details + SponsorBlock + Return YouTube Dislike + DeArrow",
				"GET /api/segments/{id}": "SponsorBlock segments (categories=sponsor,intro,…)",
				"GET /api/dislikes/{id}": "Return YouTube Dislike votes",
				"GET /api/branding/{id}": "DeArrow title/thumbnail (or /api/branding?ids=a,b,c)",
				"GET /api/playlist/{id}": "A YouTube playlist's videos (paginate with ?page=)",
				"GET /api/channel/{id|@handle}": "A channel's details and videos. tab=videos|live|shorts|playlists, page=",
				"GET /vrc/protv.playlist?q=|list=": "ProTV playlist file from a search or playlist (n=1..500)",
				"GET /vrc/search?q=": "In-world search for VRChat (see docs/vrchat-protocol.md)",
				"GET /api/rooms/new": "Create a watch-party room: returns its code and the creator's hostKey",
				"GET /api/rooms/{code}": "Room state (what's playing, position, queue, members)",
				"WS /api/rooms/{code}/ws": "Join a room: synced playback and shared queue",
				"GET /room/{code}": "VRChat players: 302 to what the room is playing right now",
			},
			credits: {
				sponsorblock: "https://sponsor.ajay.app — CC BY-NC-SA 4.0",
				dearrow: "https://dearrow.ajay.app — CC BY-NC-SA 4.0",
				returnyoutubedislike: "https://returnyoutubedislike.com",
			},
		},
		200,
		3600,
	);
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

/** First path segments the u2b-style catch-all must never treat as a search. */
const RESERVED = new Set([
	"api", "assets", "brand", "docs", "sitemap", "favicon.ico", "robots.txt", "sitemap.xml", "llms.txt",
	"site.webmanifest", "opensearch.xml", "_headers", "index.html", "docs.html", "sitemap.html", "web", "vrc", "room", "auth",
]);

/**
 * Google sign-in broker for BetterYTS Music (src/lib/google.ts has the flow). Responses are
 * no-store and carry no CORS headers: only the app calls these, never a web page.
 */
async function googleAuth(req: Request, url: URL, path: string): Promise<Response> {
	const plain = (data: unknown, status = 200) =>
		new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
	const fail = (message: string, status: number) => plain({ error: { status, message } }, status);

	const cfg = googleConfig(env);
	if (!cfg) return fail("Google sign-in isn't set up on this server yet", 503);

	if (path === "/auth/google/start" && req.method === "GET") {
		const target = authorizeUrl(url.origin, cfg.clientId, url.searchParams.get("state"), url.searchParams.get("code_challenge"));
		return typeof target === "string" ? new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } }) : fail(target.error, 400);
	}
	if (path === CALLBACK_PATH && req.method === "GET") {
		return new Response(null, { status: 302, headers: { Location: appRedirect(url.searchParams), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
	}
	if (req.method !== "POST") return fail("Method not allowed", 405);
	const body = await req.json().catch(() => null);

	if (path === "/api/auth/google/token") {
		const r = validTokenRequest(body);
		if (!r) return fail("Expected {code, code_verifier}", 400);
		const out = await googleToken({
			grant_type: "authorization_code",
			code: r.code,
			code_verifier: r.verifier,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret,
			redirect_uri: url.origin + CALLBACK_PATH,
		});
		return "error" in out ? fail(out.error, out.status) : plain(out);
	}
	if (path === "/api/auth/google/refresh") {
		const token = validToken((body as { refresh_token?: unknown } | null)?.refresh_token);
		if (!token) return fail("Expected {refresh_token}", 400);
		const out = await googleToken({ grant_type: "refresh_token", refresh_token: token, client_id: cfg.clientId, client_secret: cfg.clientSecret });
		return "error" in out ? fail(out.error, out.status) : plain(out);
	}
	if (path === "/api/auth/google/revoke") {
		const token = validToken((body as { token?: unknown } | null)?.token);
		if (!token) return fail("Expected {token}", 400);
		const res = await fetch("https://oauth2.googleapis.com/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }),
		});
		// An already-revoked or expired token is fine: the user is signed out either way.
		return plain({ ok: res.ok || res.status === 400 });
	}
	return fail("Unknown endpoint", 404);
}

async function route(req: Request, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");

	if (path.startsWith("/auth/google/") || path.startsWith("/api/auth/google/")) return googleAuth(req, url, path);
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
	if (req.method !== "GET" && req.method !== "HEAD") return errorJson("Method not allowed", 405);

	// ---- Front page (routed here first so search URLs get their own SEO tags) ----
	if (path === "/") {
		const page = await env.ASSETS.fetch(new Request(new URL("/", url.origin), req));
		const meta = frontPageMeta(url);
		return meta && page.ok && (page.headers.get("Content-Type") ?? "").includes("text/html") ? rewriteFrontPage(page, meta) : page;
	}

	// ---- JSON API ----
	if (path === "/api" || path === "/api/") return apiIndex(url.origin);
	if (path === "/api/health") return json({ ok: true, version: VERSION });
	if (path === "/api/search") return apiSearch(url, ctx);
	if (path === "/api/suggest") {
		const q = queryFromSearchParams(url);
		// format=opensearch → ["query", ["s1", "s2"]] for browser search-bar suggestions
		const openSearch = url.searchParams.get("format") === "opensearch";
		if (!q) return json(openSearch ? ["", []] : [], 200, 3600);
		const opts = clientOptions(url);
		return cached(`suggest?${opts.hl}|${opts.gl}|${+openSearch}|${q.toLowerCase()}`, ctx, async () => {
			const list = await suggestions(q, opts.hl, opts.gl);
			return json(openSearch ? [q, list] : list, 200, 3600);
		});
	}
	if (path === "/api/branding") return apiBrandingBatch(url, ctx);

	const apiId = /^\/api\/(video|segments|dislikes|branding)\/([^/]+)$/.exec(path);
	if (apiId) {
		const [, kind, id] = apiId;
		if (!isVideoId(id)) return errorJson("Invalid video ID", 400);
		if (kind === "video") return apiVideo(id, url, ctx);
		if (kind === "segments") {
			const wanted = (url.searchParams.get("categories") ?? "").split(",").filter((c) => (SB_CATEGORIES as readonly string[]).includes(c));
			return json(await sponsorSegments(id, wanted.length ? wanted : SB_CATEGORIES), 200, 300);
		}
		if (kind === "dislikes") {
			const votes = await dislikes(id);
			return votes ? json(votes, 200, 600) : errorJson("No vote data", 404);
		}
		return json(await branding(id), 200, 900);
	}

	const browseMatch = /^\/api\/(playlist|channel)\/([^/]+)$/.exec(path);
	if (browseMatch) {
		const ref = decodeURIComponent(browseMatch[2]);
		return browseMatch[1] === "playlist" ? apiPlaylist(ref, url, ctx) : apiChannel(ref, url, ctx);
	}

	if (path.startsWith("/api/rooms/")) return apiRooms(req, path);
	if (path.startsWith("/api/")) return errorJson("Unknown endpoint. See /api", 404);

	const roomMatch = /^\/room\/([A-Za-z0-9]{6})$/.exec(path);
	if (roomMatch) return roomFollow(req, roomMatch[1], url);

	// ---- In-world search for VRChat (docs/vrchat-protocol.md) ----
	if (path === "/vrc/protv.playlist") return vrcProTVPlaylist(url, ctx);
	if (path === "/vrc/info") return vrcInfo(url.origin);
	if (path === "/vrc/search") return vrcSearch(url, env, ctx, clientOptions(url));
	const slotMatch = /^\/vrc\/p\/(\d{1,6})$/.exec(path);
	if (slotMatch) return vrcSlot(slotMatch[1], env, ctx, url.origin, clientOptions(url).clientVersion);
	if (path.startsWith("/vrc/")) return text("BetterYTS: unknown /vrc endpoint. See /docs#vrchat-world\n", 404);

	// ---- Redirect endpoints ----
	if (path === "/search" || path === "/results" || path.startsWith("/search/")) {
		const q = path.startsWith("/search/") ? queryFromPath(path.slice("/search/".length)) : queryFromSearchParams(url);
		const forceLucky = boolParam(url, "lucky", false) || boolParam(url, "go", false);
		if (!forceLucky && isBrowserNavigation(req)) {
			const page = new URL("/", url.origin);
			if (q) page.searchParams.set("q", q);
			for (const k of ["type", "sort", "duration", "upload", "features"]) {
				const v = url.searchParams.get(k);
				if (v) page.searchParams.set(k, v);
			}
			return redirect(page.pathname + page.search, 0);
		}
		return luckyRedirect(q, url, ctx);
	}
	if (path === "/lucky" || path === "/go" || path === "/play") return luckyRedirect(queryFromSearchParams(url), url, ctx);

	const vid = /^\/(?:v|watch|w)\/([A-Za-z0-9_-]{11})$/.exec(path);
	if (vid) return redirect(videoUrl(vid[1], url.searchParams.get("to") ?? "watch"), 86400);
	if (path === "/watch" && isVideoId(url.searchParams.get("v"))) {
		return redirect(videoUrl(url.searchParams.get("v") as string, url.searchParams.get("to") ?? "watch"), 86400);
	}

	// ---- u2b.cx-style catch-all: yts.foulfoxhacks.dev/lofi hip hop ----
	const first = path.split("/")[1] ?? "";
	if (path !== "/" && !RESERVED.has(first.toLowerCase()) && !/\.[a-z0-9]{2,5}$/i.test(path)) {
		return luckyRedirect(queryFromPath(path), url, ctx);
	}

	return errorJson("Not found", 404);
}

export default {
	async fetch(req, _env, ctx) {
		try {
			return await route(req, ctx);
		} catch (err) {
			console.error("request failed", req.url, err);
			const status = err instanceof UpstreamError ? err.status : 502;
			const message = err instanceof Error ? err.message : "Upstream error";
			const accept = req.headers.get("Accept") ?? "";
			return new URL(req.url).pathname.startsWith("/api") || accept.includes("json")
				? errorJson(message, status)
				: text(`BetterYTS: ${message}\n`, status);
		}
	},
} satisfies ExportedHandler<Env>;
