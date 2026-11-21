// TikTok linking: consent URL, token exchange, profile + video list, revoke, library shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanVideo, exchangeCode, fetchUser, fetchVideos, newState, revokeToken, tiktokAuthorizeUrl, tiktokCodePage, tiktokConfig, tiktokDonePage, tiktokLibrary, validState } from "../src/lib/tiktok.ts";
import { cleanLibrary, libraryTrackIds, renderLibrary } from "../src/vrc/links-core.ts";

const origin = "https://yts.foulfoxhacks.dev";
const cfg = { clientKey: "test-key", clientSecret: "test-secret" };

type Call = { url: string; init?: RequestInit };
function fake(responses: Array<{ status?: number; body: unknown }>) {
	const calls: Call[] = [];
	const f = async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const r = responses.shift() ?? { body: {} };
		return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
	};
	return { f, calls };
}

test("tiktok: config and state", () => {
	assert.equal(tiktokConfig({}), null, "off until both secrets are set");
	assert.equal(tiktokConfig({ TIKTOK_CLIENT_KEY: "k" }), null);
	assert.deepEqual(tiktokConfig({ TIKTOK_CLIENT_KEY: " k ", TIKTOK_CLIENT_SECRET: "s" }), { clientKey: "k", clientSecret: "s" });
	const a = newState();
	assert.ok(validState(a) && a !== newState(), "random, URL-safe");
	assert.equal(validState("short"), false);
	assert.equal(validState("<script>".repeat(8)), false);
});

test("tiktok: consent URL asks only for the two scopes", () => {
	const u = new URL(tiktokAuthorizeUrl(origin, cfg.clientKey, "s".repeat(43)));
	assert.equal(u.origin + u.pathname, "https://www.tiktok.com/v2/auth/authorize/");
	assert.equal(u.searchParams.get("client_key"), "test-key");
	assert.equal(u.searchParams.get("response_type"), "code");
	assert.equal(u.searchParams.get("scope"), "user.info.basic,video.list");
	assert.equal(u.searchParams.get("redirect_uri"), "https://yts.foulfoxhacks.dev/tt/callback");
	assert.equal(u.searchParams.get("state"), "s".repeat(43));
	assert.ok(!u.toString().includes("test-secret"), "the secret never goes to the browser");
});

test("tiktok: token exchange", async () => {
	const ok = fake([{ body: { access_token: "act.1", open_id: "o", scope: "user.info.basic,video.list", expires_in: 7200, refresh_token: "rft" } }]);
	assert.equal(await exchangeCode(cfg, origin, "abc*!", ok.f), "act.1");
	assert.equal(ok.calls[0].url, "https://open.tiktokapis.com/v2/oauth/token/");
	assert.equal(ok.calls[0].init?.method, "POST");
	const body = new URLSearchParams(String(ok.calls[0].init?.body));
	assert.deepEqual(Object.fromEntries(body), { client_key: "test-key", client_secret: "test-secret", code: "abc*!", grant_type: "authorization_code", redirect_uri: `${origin}/tt/callback` });

	const denied = fake([{ status: 400, body: { error: "invalid_grant", error_description: "Authorization code is expired." } }]);
	await assert.rejects(exchangeCode(cfg, origin, "x", denied.f), /expired/);
	const noList = fake([{ body: { access_token: "act.1", scope: "user.info.basic" } }]);
	await assert.rejects(exchangeCode(cfg, origin, "x", noList.f), /video\.list/);
});

test("tiktok: profile, paged video list and revoke", async () => {
	const u = fake([{ body: { data: { user: { open_id: "o", display_name: "Sammy\u0000", avatar_url: "https://p16.tiktokcdn.com/a.jpg" } }, error: { code: "ok", message: "" } } }]);
	assert.deepEqual(await fetchUser("act.1", u.f), { displayName: "Sammy", avatarUrl: "https://p16.tiktokcdn.com/a.jpg" });
	assert.match(u.calls[0].url, /\/v2\/user\/info\/\?fields=open_id,display_name,avatar_url$/);
	assert.equal((u.calls[0].init?.headers as Record<string, string>).Authorization, "Bearer act.1");
	const uErr = fake([{ status: 401, body: { error: { code: "access_token_invalid", message: "bad token" } } }]);
	await assert.rejects(fetchUser("x", uErr.f), /bad token/);

	const v = (id: string) => ({ id, title: `Video ${id}`, cover_image_url: "https://p16.tiktokcdn.com/c.jpg", duration: 15.4, embed_link: `https://www.tiktok.com/player/v1/${id}` });
	const vids = fake([
		{ body: { data: { videos: [v("1"), v("2"), { id: "3", embed_link: "https://evil.example/3" }], cursor: 1700000000000, has_more: true }, error: { code: "ok" } } },
		{ body: { data: { videos: [v("2"), v("4")], cursor: 1600000000000, has_more: false }, error: { code: "ok" } } },
	]);
	const list = await fetchVideos("act.1", vids.f);
	assert.deepEqual(
		list.map((x) => x.id),
		["1", "2", "4"],
		"bad embeds and repeats dropped, pages followed",
	);
	assert.equal(list[0].duration, 15);
	assert.match(vids.calls[0].url, /\/v2\/video\/list\/\?fields=id,title,cover_image_url,duration,embed_link$/);
	assert.deepEqual(JSON.parse(String(vids.calls[0].init?.body)), { max_count: 20 });
	assert.deepEqual(JSON.parse(String(vids.calls[1].init?.body)), { max_count: 20, cursor: 1700000000000 });

	const rev = fake([{ body: {} }]);
	await revokeToken(cfg, "act.1", rev.f);
	assert.equal(rev.calls[0].url, "https://open.tiktokapis.com/v2/oauth/revoke/");
	assert.equal(new URLSearchParams(String(rev.calls[0].init?.body)).get("token"), "act.1");
	await revokeToken(cfg, "act.1", async () => {
		throw new Error("offline");
	}); // never throws
});

test("tiktok: video cleaning", () => {
	assert.equal(cleanVideo({ id: "abc", embed_link: "https://www.tiktok.com/x" }), null, "numeric IDs only");
	assert.equal(cleanVideo({ id: "1", embed_link: "http://www.tiktok.com/x" }), null, "https only");
	assert.equal(cleanVideo({ id: "1", embed_link: "https://tiktok.com.evil.example/x" }), null, "TikTok's own player only");
	assert.deepEqual(cleanVideo({ id: 7, title: "", embed_link: "https://www.tiktok.com/player/v1/7", duration: -1 }), { id: "7", title: "TikTok video", cover: null, duration: 0, embed: "https://www.tiktok.com/player/v1/7" });
});

test("tiktok: library is one playlist of the user's videos, polled without pool slots", () => {
	const user = { displayName: "Sammy", avatarUrl: "https://p16.tiktokcdn.com/a.jpg" };
	const videos = [{ id: "123", title: "Hi", cover: "https://p16.tiktokcdn.com/c.jpg", duration: 12, embed: "https://www.tiktok.com/player/v1/123" }];
	const lib = tiktokLibrary(user, videos);
	assert.ok(!JSON.stringify(lib).includes("avatar") && !JSON.stringify(lib).includes("p16.tiktokcdn.com/a.jpg"), "no avatar stored");
	assert.deepEqual(libraryTrackIds(lib), [], "no YouTube pool slots for TikTok");
	const polled = renderLibrary(lib, [], null, null);
	assert.equal(polled.service, "tiktok");
	assert.equal(polled.account, "Sammy");
	assert.deepEqual(polled.playlists, [{ name: "My TikTok videos", tracks: [{ title: "Hi", channel: "Sammy", slot: null, id: "123", embed_link: "https://www.tiktok.com/player/v1/123", cover_image_url: "https://p16.tiktokcdn.com/c.jpg", duration: 12 }] }]);
	assert.equal(polled.library, null);
	assert.throws(() => cleanLibrary({ playlists: [] }, "tiktok"), /signing in/, "clients can't post TikTok libraries");
});

test("tiktok: pages escape what TikTok sends", () => {
	const page = tiktokDonePage({ displayName: "<b>x</b>", avatarUrl: "" }, [{ id: "1", title: '"><script>', cover: null, duration: 65, embed: "https://www.tiktok.com/player/v1/1" }], true);
	assert.ok(!page.includes("<script>") && !page.includes("<b>x</b>"));
	assert.match(page, /1:05/);
	assert.match(page, /\/privacy#tiktok/);
	const form = tiktokCodePage('"><x>');
	assert.ok(!form.includes('"><x>'));
	assert.match(form, /Continue with TikTok/);
	assert.match(tiktokCodePage("", "", false), /isn't set up/);
});
