// Response helpers: JSON + CORS + edge caching.

export const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
	// API responses and redirects are crawlable but never belong in a search index.
	"X-Robots-Tag": "noindex",
};

export function json(data: unknown, status = 200, maxAge = 0): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			...CORS_HEADERS,
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export function errorJson(message: string, status: number): Response {
	return json({ error: { status, message } }, status);
}

export function text(body: string, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
	});
}

export function redirect(location: string, maxAge = 300): Response {
	return new Response(`Redirecting to ${location}\n`, {
		status: 302,
		headers: {
			...CORS_HEADERS,
			Location: location,
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
		},
	});
}

/** Workers' default edge cache (a no-op outside Workers or on workers.dev). */
function edgeCache(): Cache | null {
	try {
		return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
	} catch {
		return null;
	}
}

/**
 * Serve from the edge cache when we can; otherwise build the response and store it.
 * Only 200s are cached, and only for as long as their Cache-Control says.
 */
export async function cached(key: string, ctx: ExecutionContext, build: () => Promise<Response>): Promise<Response> {
	const cache = edgeCache();
	const cacheKey = new Request(`https://cache.betteryts.internal/${key}`);
	if (cache) {
		const hit = await cache.match(cacheKey);
		if (hit) {
			const res = new Response(hit.body, hit);
			res.headers.set("X-Cache", "HIT");
			return res;
		}
	}
	const res = await build();
	if (cache && res.status === 200 && !/no-store/.test(res.headers.get("Cache-Control") ?? "")) {
		ctx.waitUntil(cache.put(cacheKey, res.clone()));
	}
	res.headers.set("X-Cache", "MISS");
	return res;
}
