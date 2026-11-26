// The Worker's routes against a fake YouTube.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { route } from "../src/index.ts";

// Anonymized recording of a /live_chat page (same file as the Ametherian package's test fixture).
const chatPage = await readFile(new URL("./fixtures/live-chat-page.txt", import.meta.url), "utf8");
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const realFetch = globalThis.fetch;
const calls: string[] = [];
let answer: (url: string) => Response = () => new Response("", { status: 500 });
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	calls.push(url);
	return answer(url);
}) as typeof fetch;
afterEach(() => (calls.length = 0));
process.on("exit", () => (globalThis.fetch = realFetch));
const get = (path: string) => route(new Request(`https://ytchat.foulfoxhacks.dev${path}`), ctx);

test("robots, health and unknown paths; never indexable", async () => {
	assert.match(await (await get("/robots.txt")).text(), /Disallow: \//);
	const health = await get("/health");
	assert.equal(health.status, 200);
	assert.equal(health.headers.get("X-Robots-Tag"), "noindex, nofollow");
	assert.equal((await get("/nope")).status, 404);
	assert.equal((await route(new Request("https://ytchat.foulfoxhacks.dev/v1/live", { method: "POST" }), ctx)).status, 405);
});

test("/v1/live validates the target and returns the chat bootstrap", async () => {
	assert.equal((await get("/v1/live?target=https://evil.example/")).status, 400);
	assert.equal(calls.length, 0, "invalid targets never reach YouTube");
	answer = () => new Response(chatPage);
	const res = await get("/v1/live?target=4t4AQ15yj1M");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
	const body = await res.json();
	assert.equal(body.videoId, "4t4AQ15yj1M");
	assert.ok(body.messages.length > 0 && body.continuation && body.pollMs > 0);
	assert.deepEqual(calls, ["https://www.youtube.com/live_chat?v=4t4AQ15yj1M"]);
});

test("errors map to HTTP: not live 404, rate-limited 503 with Retry-After, other upstream trouble 502", async () => {
	answer = () => new Response("<html>no chat</html>");
	assert.equal((await get("/v1/live?target=4t4AQ15yj1M")).status, 404);
	answer = () => new Response("", { status: 429 });
	const limited = await get("/v1/live?target=@LofiGirl");
	assert.equal(limited.status, 503);
	assert.equal(limited.headers.get("Retry-After"), "30");
	answer = () => new Response("{oops");
	const bad = await get("/v1/chat?continuation=0ofMyANyntheticNextContinuationToken01");
	assert.equal(bad.status, 502);
	assert.doesNotMatch(await bad.text(), /oops/, "upstream bodies are never echoed");
	assert.equal((await get("/v1/chat?continuation=short")).status, 400);
});
