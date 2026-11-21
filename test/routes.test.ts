// The Worker's router, loaded for real (test/support stubs the Workers runtime). Upstream calls go
// to a fake fetch, so these check input validation, redirects, error handling and the VRChat pool.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { env } from "cloudflare:workers";
import { namespace } from "./support/do.ts";
import { redactUrl } from "../src/lib/http.ts";
import { VrcPool } from "../src/vrc/pool.ts";
import { VrcLinks } from "../src/vrc/links.ts";
import { POOL_SIZE } from "../src/vrc/protocol.ts";

Object.assign(env as object, {
	DEFAULT_HL: "en",
	DEFAULT_GL: "US",
	YT_CLIENT_VERSION: "2.20251114.01.00",
	SPOTIFY_CLIENT_ID: "783ca1075f974251a85c57c275adc49e",
	TIKTOK_MODE: "sandbox",
	VRC_POOL: namespace(VrcPool),
	VRC_LINKS: namespace(VrcLinks),
	ASSETS: { fetch: async () => new Response("<!doctype html><title>BetterYTS</title>", { headers: { "Content-Type": "text/html" } }) },
});
const worker = (await import("../src/index.ts")).default;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const realFetch = globalThis.fetch;
let upstream: (url: string) => Response | Promise<Response> = () => {
	throw new Error("unexpected upstream call");
};
globalThis.fetch = (async (input: RequestInfo | URL) => upstream(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)) as typeof fetch;
afterEach(() => {
	upstream = () => {
		throw new Error("unexpected upstream call");
	};
});
process.on("exit", () => (globalThis.fetch = realFetch));

const call = (path: string, init: RequestInit = {}) => worker.fetch!(new Request(`https://yts.foulfoxhacks.dev${path}`, init) as never, env as never, ctx);

test("routes: health, index and OpenAPI", async () => {
	const h = await call("/api/health");
	assert.equal(h.status, 200);
	assert.equal(((await h.json()) as { ok: boolean }).ok, true);
	assert.ok(h.headers.get("Strict-Transport-Security"), "HSTS on every response");
	const spec = (await (await call("/api/openapi.json")).json()) as { openapi: string; paths: object };
	assert.match(spec.openapi, /^3\.1/);
	const cfg = (await (await call("/api/auth/config")).json()) as { spotify: boolean; google: boolean };
	assert.equal(cfg.spotify, true);
	assert.equal(cfg.google, false, "no Google secrets in this env");
});

test("routes: malformed input is rejected before any upstream call", async () => {
	assert.equal((await call("/api/video/not-an-id")).status, 400);
	assert.equal((await call("/api/video/abc")).status, 400);
	assert.equal((await call("/api/segments/%3Cscript%3E")).status, 400);
	assert.equal((await call("/api/search")).status, 400, "missing q");
	assert.equal((await call(`/api/search?q=x&page=${"a".repeat(5000)}`)).status, 400, "oversized page token");
	assert.equal((await call("/api/playlist/!!")).status, 400);
	assert.equal((await call("/api/channel/nope")).status, 400);
	assert.equal((await call("/api/branding?ids=bad,worse")).status, 400);
	assert.equal((await call("/api/rooms/zz")).status, 404);
	assert.equal((await call("/api/nope")).status, 404);
	assert.equal((await call("/api/health", { method: "DELETE" })).status, 405);
	assert.equal((await call("/vrc/p/99999999")).status, 404, "slot out of range");
	assert.equal((await call(`/vrc/p/${POOL_SIZE}`)).status, 404);
});

test("routes: video redirects never leave YouTube's domains", async () => {
	const r = await call("/v/dQw4w9WgXcQ?to=https://evil.example");
	assert.equal(r.status, 302);
	assert.equal(r.headers.get("Location"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "unknown targets fall back to watch");
	assert.equal((await call("/v/dQw4w9WgXcQ?to=embed")).headers.get("Location"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
	assert.equal((await call("/watch?v=dQw4w9WgXcQ&to=music")).headers.get("Location"), "https://music.youtube.com/watch?v=dQw4w9WgXcQ");
	// A video link pasted as the "search" goes straight there, without searching.
	assert.equal((await call("/search?q=https://youtu.be/dQw4w9WgXcQ")).headers.get("Location"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("routes: OAuth callbacks only forward well-formed values to fixed destinations", async () => {
	const g = await call("/auth/spotify/callback?state=web_abcdefghijklmnopqrstuvwx&code=AQB-code_1234567890&redirect=https://evil.example");
	assert.equal(g.status, 302);
	const loc = g.headers.get("Location") ?? "";
	assert.ok(loc.startsWith("https://yts.foulfoxhacks.dev/?link=spotify&"), loc);
	assert.ok(!loc.includes("evil"));
	assert.equal(g.headers.get("Cache-Control"), "no-store");
	const app = (await call("/auth/spotify/callback?state=appstate1234567890ab&code=<x>")).headers.get("Location") ?? "";
	assert.ok(app.startsWith("betterytsmusic://oauth/spotify?"), app);
	assert.match(app, /error=invalid_response/, "a malformed code isn't passed on");
	assert.equal((await call("/auth/spotify/start?state=short&code_challenge=x")).status, 400);
	assert.equal((await call("/auth/google/start?state=abcdefghijklmnop&code_challenge=x")).status, 503, "Google off without secrets");
});

test("routes: upstream failures are errors, not empty results", async () => {
	upstream = () => new Response("Service Unavailable", { status: 503 });
	const r = await call("/api/search?q=lofi");
	assert.ok(r.status >= 500, `got ${r.status}`);
	const err = (await r.json()) as { error?: { message: string }; results?: unknown };
	assert.ok(err.error?.message, "has an error message");
	assert.equal(err.results, undefined);

	upstream = () => {
		throw new TypeError("network down");
	};
	const v = await call("/vrc/search?q=lofi");
	assert.equal(v.status, 200, "VRChat always gets readable JSON");
	const body = (await v.json()) as { ok: boolean; error?: string };
	assert.equal(body.ok, false);
	assert.ok(body.error);

	const lucky = await call("/lofi%20hip%20hop", { headers: { "User-Agent": "VRChat/2026 UnityPlayer" } });
	assert.ok(lucky.status >= 500, "the redirect shortcut reports the failure too");
	assert.equal(lucky.headers.get("Location"), null);
});

test("routes: reserved paths are never treated as searches", async () => {
	upstream = () => {
		throw new Error("should not search");
	};
	for (const p of ["/api", "/vrc/unknown", "/privacy.html", "/favicon.ico", "/inworld", "/link"]) {
		const r = await call(p);
		assert.notEqual(r.status, 502, p);
	}
	assert.equal((await call("/inworld/youtube/auth?code=k7qx m2pa")).headers.get("Location"), "/?view=link&service=youtube&code=K7QX-M2PA");
});

test("routes: TikTok linking page says when it's in testing, and has a strict CSP", async () => {
	const r = await call("/inworld/tiktok");
	assert.equal(r.status, 200);
	const csp = r.headers.get("Content-Security-Policy") ?? "";
	assert.match(csp, /default-src 'none'/);
	assert.match(csp, /form-action 'self'/);
	assert.doesNotMatch(csp, /script-src/, "no scripts at all");
	const page = await r.text();
	// Without the sandbox secret it's "not set up"; with it, the testing note shows.
	assert.match(page, /isn't set up|Testing:/);
	(env as Record<string, unknown>).TIKTOK_SANDBOX_CLIENT_KEY = "sbkey";
	(env as Record<string, unknown>).TIKTOK_SANDBOX_CLIENT_SECRET = "sbsecret";
	try {
		const t = await (await call("/inworld/tiktok")).text();
		assert.match(t, /Testing:/);
		assert.doesNotMatch(t, /sbsecret/, "the secret never reaches a page");
	} finally {
		delete (env as Record<string, unknown>).TIKTOK_SANDBOX_CLIENT_KEY;
		delete (env as Record<string, unknown>).TIKTOK_SANDBOX_CLIENT_SECRET;
	}
});

test("pool: dedupes, wraps around the ring and never caches video redirects", async () => {
	const pool = namespace(VrcPool).getByName("p");
	const [a, b] = pool.assign([
		{ kind: "video", key: "v:aaaaaaaaaaa", payload: "aaaaaaaaaaa" },
		{ kind: "video", key: "v:bbbbbbbbbbb", payload: "bbbbbbbbbbb" },
	]);
	assert.deepEqual([a, b], [0, 1]);
	assert.deepEqual(pool.assign([{ kind: "video", key: "v:aaaaaaaaaaa", payload: "aaaaaaaaaaa" }]), [0], "same key, same slot");
	const many = pool.assign(Array.from({ length: POOL_SIZE }, (_, i) => ({ kind: "video" as const, key: `v:${i}`, payload: String(i) })));
	assert.equal(many.at(-1), 1, "wrapped: the oldest slots are reused");
	assert.equal(pool.lookup(0)?.key, `v:${POOL_SIZE - 2}`);
	assert.equal(pool.stats().used, POOL_SIZE);

	const live = (env as unknown as { VRC_POOL: { getByName(n: string): VrcPool } }).VRC_POOL.getByName("pool-v1");
	const [slot] = live.assign([{ kind: "video", key: "v:dQw4w9WgXcQ", payload: "dQw4w9WgXcQ" }]);
	const r = await call(`/vrc/p/${slot}`);
	assert.equal(r.status, 302);
	assert.equal(r.headers.get("Location"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
	assert.equal(r.headers.get("Cache-Control"), "no-store", "a reused slot must not replay a cached video");
	assert.equal((await call("/vrc/p/19999")).status, 404, "empty slot: a clear message, not a crash");
});

test("logging: redactUrl hides codes, OAuth values and saved-library keys", () => {
	assert.equal(redactUrl("https://x.dev/vrc/l/1234"), "https://x.dev/vrc/l/%E2%80%A6");
	assert.equal(redactUrl("https://x.dev/vrc/k/42?x=1"), "https://x.dev/vrc/k/%E2%80%A6?x=1");
	const r = redactUrl("https://x.dev/auth/spotify/callback?code=SECRET&state=web_abc&q=lofi");
	assert.ok(!r.includes("SECRET") && !r.includes("web_abc"), r);
	assert.match(r, /q=lofi/, "harmless values stay for debugging");
	assert.ok(!redactUrl("https://x.dev/api/inworld/check?code=K7QX-M2PA").includes("K7QX"));
	assert.equal(redactUrl("not a url"), "(unparseable URL)");
});
