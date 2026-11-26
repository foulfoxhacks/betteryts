// BetterYTS chat Worker: YouTube live chat as a small JSON API, on its own host so scraping traffic
// never touches yts.foulfoxhacks.dev. Stateless: clients carry the continuation between polls, and
// the edge cache lets every client watching one stream share a single upstream request.
//
//   GET /v1/live?target=@handle|UC…|videoId  → { videoId, messages, deleted, continuation, clientVersion, pollMs }
//   GET /v1/chat?continuation=…&clientVersion=… → { messages, deleted, continuation, pollMs, ended }
import { fetchChat, findLiveChat, parseTarget } from "@foulfoxhacks/ametherian-youtube-chat";

const HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"X-Robots-Tag": "noindex, nofollow",
	"X-Content-Type-Options": "nosniff",
	"Content-Type": "application/json; charset=utf-8",
};

const json = (data: unknown, status = 200, maxAge = 0, extra: Record<string, string> = {}) =>
	new Response(JSON.stringify(data), { status, headers: { ...HEADERS, "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store", ...extra } });

/** Ametherian error codes → HTTP. Anything unknown is a 502: the cause is upstream. */
function failure(err: unknown): Response {
	const e = err as { code?: string; retryable?: boolean; details?: { status?: number | null }; message?: string };
	const status = { AMETHERIAN_YTCHAT_NOT_LIVE: 404, AMETHERIAN_CONFIG: 400 }[e.code ?? ""] ?? (e.details?.status === 429 ? 503 : 502);
	const message = status === 502 ? "YouTube didn't answer as expected" : (e.message ?? "Error");
	return json({ error: { status, code: e.code ?? "UPSTREAM", message, retryable: status >= 500 && e.retryable !== false } }, status, status === 404 ? 15 : 0, status === 503 ? { "Retry-After": "30" } : {});
}

/** Serves `build()` from the edge cache for `ttl` seconds (only 200s are cached). */
async function shared(key: string, ttl: number, ctx: ExecutionContext, build: () => Promise<Response>): Promise<Response> {
	const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
	const req = new Request(`https://cache.ytchat.internal/${key}`);
	const hit = await cache?.match(req);
	if (hit) return hit;
	const res = await build();
	if (cache && res.status === 200) ctx.waitUntil(cache.put(req, res.clone()));
	return res;
}

export async function route(req: Request, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(req.url);
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
	if (req.method !== "GET") return json({ error: { status: 405, message: "Use GET" } }, 405);
	if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
	if (url.pathname === "/health") return json({ ok: true });

	if (url.pathname === "/v1/live") {
		const target = parseTarget(url.searchParams.get("target") ?? "");
		if (!target) return json({ error: { status: 400, message: "target must be a video ID, a channel ID (UC…) or an @handle" } }, 400);
		const view = url.searchParams.get("view") === "top" ? "top" : "all";
		return shared(`live/${view}/${target.kind}/${target.id.toLowerCase()}`, 15, ctx, () =>
			findLiveChat(target, { view }).then((chat) => json(chat, 200, 15), failure),
		);
	}
	if (url.pathname === "/v1/chat") {
		const continuation = url.searchParams.get("continuation") ?? "";
		const clientVersion = url.searchParams.get("clientVersion") ?? undefined;
		if (!/^[A-Za-z0-9_%=-]{16,4096}$/.test(continuation)) return json({ error: { status: 400, message: "Pass the continuation from the last answer" } }, 400);
		return shared(`chat/${continuation}`, 2, ctx, () => fetchChat({ continuation, clientVersion }).then((page) => json(page, 200, 2), failure));
	}
	return json({ error: { status: 404, message: "Unknown endpoint: GET /v1/live?target= or /v1/chat?continuation=" } }, 404);
}

export default {
	async fetch(req, _env, ctx) {
		try {
			return await route(req, ctx);
		} catch (err) {
			return failure(err);
		}
	},
} satisfies ExportedHandler;
