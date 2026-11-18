// Offline unit tests: `npm test` (Node's built-in runner, no extra deps).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanDeArrowTitle, pickBranding } from "../src/lib/addons.ts";
import { encodeSearchParams } from "../src/lib/innertube.ts";
import { parseCount, parseDuration, parseSearchResponse } from "../src/lib/parse.ts";
import { boolParam, intParam, queryFromPath, queryFromSearchParams, videoIdFromQuery } from "../src/lib/query.ts";

const u = (s: string) => new URL(`https://yts.foulfoxhacks.dev${s}`);

test("query: every URL shape yields the search term", () => {
	assert.equal(queryFromSearchParams(u("/search?q=lofi+hip+hop")), "lofi hip hop");
	assert.equal(queryFromSearchParams(u("/search?=lofi%20hip%20hop")), "lofi hip hop");
	assert.equal(queryFromSearchParams(u("/search?lofi+hip+hop")), "lofi hip hop");
	assert.equal(queryFromSearchParams(u("/search?lofi+hip+hop&n=2")), "lofi hip hop");
	assert.equal(queryFromSearchParams(u("/search?n=2&lucky")), "");
	assert.equal(queryFromSearchParams(u("/results?search_query=cats")), "cats");
	assert.equal(queryFromSearchParams(u("/search?q=%20%20spaced%20%20out%20")), "spaced out");
	assert.equal(queryFromPath("lofi%20hip%20hop"), "lofi hip hop");
	assert.equal(queryFromPath("/lofi+hip+hop"), "lofi hip hop");
	assert.equal(queryFromPath("100%25 bad%"), "100% bad%");
	assert.equal(queryFromSearchParams(u(`/search?q=${"a".repeat(500)}`)).length, 200);
});

test("query: YouTube links and id: prefix become direct video IDs", () => {
	assert.equal(videoIdFromQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
	assert.equal(videoIdFromQuery("youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.equal(videoIdFromQuery("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.equal(videoIdFromQuery("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.equal(videoIdFromQuery("id:dQw4w9WgXcQ"), "dQw4w9WgXcQ");
	assert.equal(videoIdFromQuery("programming"), null); // 11 chars, but a word
	assert.equal(videoIdFromQuery("lofi hip hop"), null);
	assert.equal(videoIdFromQuery("https://example.com/watch?v=dQw4w9WgXcQ"), null);
});

test("query: int/bool params", () => {
	assert.equal(intParam(u("/x?n=3"), "n", 1, 1, 20), 3);
	assert.equal(intParam(u("/x?n=99"), "n", 1, 1, 20), 20);
	assert.equal(intParam(u("/x?n=abc"), "n", 1, 1, 20), 1);
	assert.equal(boolParam(u("/x?lucky"), "lucky", false), true);
	assert.equal(boolParam(u("/x?shorts=0"), "shorts", true), false);
	assert.equal(boolParam(u("/x"), "shorts", true), true);
});

test("search params protobuf matches YouTube's own sp values", () => {
	assert.equal(encodeSearchParams({}), undefined);
	assert.equal(encodeSearchParams({ type: "video" }), "EgIQAQ==");
	assert.equal(encodeSearchParams({ type: "channel" }), "EgIQAg==");
	assert.equal(encodeSearchParams({ type: "playlist" }), "EgIQAw==");
	assert.equal(encodeSearchParams({ sort: "date" }), "CAI=");
	assert.equal(encodeSearchParams({ sort: "views" }), "CAM=");
	assert.equal(encodeSearchParams({ features: ["live"] }), "EgJAAQ==");
	assert.equal(encodeSearchParams({ upload: "today", type: "video" }), "EgQIAhAB");
	// multi-byte field tag (hdr = 25)
	assert.equal(encodeSearchParams({ features: ["hdr"] }), "EgPIAQE=");
});

test("parse helpers", () => {
	assert.equal(parseDuration("1:02:03"), 3723);
	assert.equal(parseDuration("4:05"), 245);
	assert.equal(parseDuration("LIVE"), null);
	assert.equal(parseCount("1,234,567 views"), 1234567);
	assert.equal(parseCount("8,197 watching"), 8197);
	assert.equal(parseCount("1.2M views"), null);
	assert.equal(parseCount("No views"), null);
});

const video = (id: string, extra: object = {}) => ({
	videoRenderer: {
		videoId: id,
		title: { runs: [{ text: `Video ${id}` }] },
		lengthText: { simpleText: "3:33" },
		viewCountText: { simpleText: "1,000 views" },
		ownerText: { runs: [{ text: "Fox", navigationEndpoint: { browseEndpoint: { browseId: "UCfox", canonicalBaseUrl: "/@fox" } } }] },
		ownerBadges: [{ metadataBadgeRenderer: { style: "BADGE_STYLE_TYPE_VERIFIED" } }],
		...extra,
	},
});

test("parser: strips ads, tags shelves, dedupes, finds continuation", () => {
	const data = {
		estimatedResults: "12345",
		contents: {
			twoColumnSearchResultsRenderer: {
				primaryContents: {
					sectionListRenderer: {
						contents: [
							{
								itemSectionRenderer: {
									contents: [
										{ adSlotRenderer: { content: video("AAAAAAAAAAA") } },
										{ showingResultsForRenderer: { correctedQuery: { runs: [{ text: "fox" }] } } },
										video("dQw4w9WgXcQ"),
										{ searchPyvRenderer: { ads: [video("BBBBBBBBBBB")] } },
										video("shortsAAAAA", { navigationEndpoint: { reelWatchEndpoint: { videoId: "shortsAAAAA" } } }),
										{ shelfRenderer: { title: { simpleText: "People also watched" }, content: { verticalListRenderer: { items: [video("CCCCCCCCCCC"), video("dQw4w9WgXcQ")] } } } },
										{ reelShelfRenderer: { title: { simpleText: "Shorts" }, items: [{ reelItemRenderer: { videoId: "DDDDDDDDDDD", headline: { simpleText: "a short" } } }] } },
										{ channelRenderer: { channelId: "UCfox", title: { simpleText: "Fox" }, subscriberCountText: { simpleText: "@fox" }, videoCountText: { simpleText: "1K subscribers" } } },
										{ playlistRenderer: { playlistId: "PL123", title: { simpleText: "List" }, videoCount: "5" } },
									],
								},
							},
							{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "NEXT" } } } },
						],
					},
				},
			},
		},
	};
	const r = parseSearchResponse(data);
	assert.equal(r.blocked.ads, 2);
	assert.equal(r.next, "NEXT");
	assert.equal(r.estimatedResults, 12345);
	assert.equal(r.correctedQuery, "fox");
	const ids = r.results.map((i) => i.id);
	assert.deepEqual(ids, ["dQw4w9WgXcQ", "shortsAAAAA", "CCCCCCCCCCC", "DDDDDDDDDDD", "UCfox", "PL123"]);
	assert.ok(!ids.includes("AAAAAAAAAAA") && !ids.includes("BBBBBBBBBBB"), "ads must be dropped");
	const first = r.results[0];
	assert.equal(first.type, "video");
	if (first.type === "video") {
		assert.equal(first.durationSeconds, 213);
		assert.equal(first.channel?.handle, "@fox");
		assert.equal(first.channel?.verified, true);
	}
	assert.equal(r.results[1].type, "short");
	assert.equal(r.results[2].shelf, "People also watched");
	assert.equal(r.results[3].shelf, "Shorts");
	const ch = r.results[4];
	if (ch.type === "channel") {
		assert.equal(ch.handle, "@fox");
		assert.equal(ch.subscribers, "1K subscribers");
	}
});

test("DeArrow: picks trusted community title and cleans markers", () => {
	assert.equal(cleanDeArrowTitle(">I Built a >USB Fox"), "I Built a USB Fox");
	const b = pickBranding("dQw4w9WgXcQ", {
		titles: [
			{ title: "bad", original: false, votes: -2, locked: false },
			{ title: "Original title", original: true, votes: 5 },
			{ title: "Good >AI title", original: false, votes: 0, locked: false },
		],
		thumbnails: [{ timestamp: 42.5, original: false, votes: 1 }],
	});
	assert.equal(b.title, "Good AI title");
	assert.equal(b.thumbnailTime, 42.5);
	assert.match(b.thumbnail ?? "", /videoID=dQw4w9WgXcQ&time=42.5$/);
	assert.deepEqual(pickBranding("x", {}), { title: null, thumbnail: null, thumbnailTime: null });
});

test("SEO: plain home is untouched, search/watch URLs get noindex + descriptive titles", async () => {
	const { frontPageMeta } = await import("../src/lib/seo.ts");
	assert.equal(frontPageMeta(u("/")), null);
	assert.equal(frontPageMeta(u("/?utm_source=x")), null);
	const s = frontPageMeta(u("/?q=lofi+hip+hop"));
	assert.equal(s?.robots, "noindex, follow");
	assert.equal(s?.title, "“lofi hip hop” — YouTube search without ads · BetterYTS by FoulFoxHacks");
	assert.match(s?.description ?? "", /search\?q=lofi%20hip%20hop/);
	assert.equal(frontPageMeta(u("/?v=dQw4w9WgXcQ"))?.robots, "noindex, follow");
	assert.ok((frontPageMeta(u(`/?q=${"x".repeat(500)}`))?.title.length ?? 0) < 200);
});

test("vrc: playable filter and 12-per-page pagination across YouTube pages", async () => {
	const { playable, paginate } = await import("../src/vrc/handlers.ts");
	const v = (id: string, extra: object = {}) => ({ type: "video", id, title: id, isShort: false, upcoming: false, live: false, durationSeconds: 200, ...extra }) as never;
	const items = [
		v("a"), v("short", { isShort: true }), v("up", { upcoming: true }), v("shelf", { shelf: "People also watched" }),
		v("live", { live: true }), v("long", { durationSeconds: 5000 }),
		...Array.from({ length: 14 }, (_, i) => v(`n${i}`)),
	];
	const ok = playable(items, { live: false, minlen: 0, maxlen: 600 });
	assert.ok(!ok.some((x: { id: string }) => ["short", "up", "shelf", "live", "long"].includes(x.id)));
	assert.equal(ok.length, 15);
	const base = { q: "x", live: true, minlen: 0, maxlen: 0, hl: "en", gl: "US", token: null, offset: 0 };
	const p1 = paginate(ok, base, "YT2");
	assert.equal(p1.shown.length, 12);
	assert.deepEqual(p1.next, { ...base, offset: 12 });
	const p2 = paginate(ok, p1.next!, "YT2");
	assert.equal(p2.shown.length, 3);
	assert.deepEqual(p2.next, { ...base, token: "YT2", offset: 0 });
	assert.equal(paginate(ok.slice(0, 5), base, null).next, null);
});

test("query: empty q= is an empty search, not the letter q", () => {
	assert.equal(queryFromSearchParams(u("/vrc/search?q=")), "");
	assert.equal(queryFromSearchParams(u("/search?query=")), "");
});

test("browse: playlist and channel references", async () => {
	const { playlistIdFrom, channelRefFrom } = await import("../src/lib/browse.ts");
	assert.equal(playlistIdFrom("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"), "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI");
	assert.equal(playlistIdFrom("https://youtube.com/watch?v=x&list=PLabcdefghij&index=2"), "PLabcdefghij");
	assert.equal(playlistIdFrom("nope"), null);
	assert.equal(channelRefFrom("@LofiGirl"), "@LofiGirl");
	assert.equal(channelRefFrom("https://www.youtube.com/@LofiGirl/videos"), "@LofiGirl");
	assert.equal(channelRefFrom("https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow"), "UCSJ4gkVC6NrvII8umztf0Ow");
	assert.equal(channelRefFrom("not a channel"), null);
});

test("protv: tokenized playlist escapes prefix symbols and multi-line titles", async () => {
	const { toProTVPlaylist } = await import("../src/lib/protv.ts");
	const v = (id: string, title: string, extra: object = {}) =>
		({ type: "video", id, title, duration: "3:33", views: "1 view", live: false, channel: { name: "Fox" }, ...extra }) as never;
	const out = toProTVPlaylist("My list", [v("aaaaaaaaaaa", "@not a url"), v("bbbbbbbbbbb", "line one\nline two", { channel: { name: "#chan" } })]);
	const lines = out.split("\n");
	assert.equal(lines[0], "My list");
	assert.equal(lines.filter((l: string) => l.startsWith("@")).length, 2);
	assert.ok(lines.includes("~@not a url"));
	assert.ok(lines.includes("~line one line two"));
	assert.ok(lines.some((l: string) => l === "​#chan · 3:33 · 1 view"));
});

test("rooms: state machine for load, play/pause/seek, queue and end-of-video", async () => {
	const { applyMessage, emptyState, currentPosition, cleanVideo, newRoomCode, ROOM_CODE_RE } = await import("../src/rooms/protocol.ts");
	const a = { id: "aaaaaaaaaaa", title: "A" };
	const b = { id: "bbbbbbbbbbb", title: "B" };
	let s = emptyState();
	assert.equal(applyMessage(s, { t: "play", position: 3 }, 0), null, "nothing to play yet");
	s = applyMessage(s, { t: "queue_add", video: a }, 1000)!; // first add starts playing
	assert.equal(s.video?.id, "aaaaaaaaaaa");
	assert.equal(s.playing, true);
	s = applyMessage(s, { t: "queue_add", video: b }, 1000)!;
	assert.equal(s.queue.length, 1);
	assert.equal(currentPosition(s, 11000), 10);
	s = applyMessage(s, { t: "pause", position: 42 }, 2000)!;
	assert.equal(currentPosition(s, 99999), 42);
	s = applyMessage(s, { t: "seek", position: 100 }, 3000)!;
	assert.equal(s.position, 100);
	assert.equal(applyMessage(s, { t: "ended", id: "bbbbbbbbbbb" }, 4000), null, "stale end report ignored");
	const rev = s.rev;
	s = applyMessage(s, { t: "ended", id: "aaaaaaaaaaa" }, 4000)!;
	assert.equal(s.video?.id, "bbbbbbbbbbb");
	assert.equal(s.queue.length, 0);
	assert.equal(s.rev, rev + 1);
	s = applyMessage(s, { t: "next" }, 5000)!;
	assert.equal(s.video, null);
	assert.equal(s.playing, false);
	assert.equal(cleanVideo({ id: "bad", title: "x" }), null);
	assert.equal(cleanVideo({ id: "aaaaaaaaaaa", title: "x".repeat(500) })?.title.length, 200);
	assert.equal(applyMessage(s, { t: "seek", position: Number.NaN } as never), null);
	for (let i = 0; i < 20; i++) assert.match(newRoomCode(), ROOM_CODE_RE);
});

test("rooms: host keys and host-only lock", async () => {
	const { applyMessage, emptyState, mayControl, newHostKey, sameKey, HOST_KEY_RE } = await import("../src/rooms/protocol.ts");
	const key = newHostKey();
	assert.match(key, HOST_KEY_RE);
	assert.notEqual(key, newHostKey());
	assert.ok(sameKey(key, key));
	assert.ok(!sameKey(key, newHostKey()));
	assert.ok(!sameKey(key, key.slice(1)));

	let s = emptyState();
	const load = { t: "load", video: { id: "aaaaaaaaaaa", title: "A" } } as const;
	const lock = { t: "lock", locked: true } as const;
	assert.ok(mayControl(s, load, false), "unlocked rooms are open to everyone");
	assert.ok(!mayControl(s, lock, false), "only hosts may lock");
	assert.ok(mayControl(s, lock, true));
	s = applyMessage(s, lock, 0)!;
	assert.equal(s.locked, true);
	assert.equal(applyMessage(s, lock, 0), null, "locking twice changes nothing");
	assert.ok(!mayControl(s, load, false), "guests can't control a locked room");
	assert.ok(!mayControl(s, { t: "seek", position: 5 }, false));
	assert.ok(!mayControl(s, { t: "queue_remove", index: 0 }, false));
	assert.ok(mayControl(s, load, true), "hosts still can");
	assert.ok(mayControl(s, { t: "ended", id: "aaaaaaaaaaa" }, false), "anyone may report the end of a video");
	assert.ok(mayControl(s, { t: "hello", name: "x" }, false));
	s = applyMessage(s, { t: "lock", locked: false }, 0)!;
	assert.equal(s.locked, false);
	// Rooms saved before hosts existed have no `locked` field and stay open.
	const legacy = { ...emptyState(), locked: undefined };
	assert.ok(mayControl(legacy, load, false));
});

test("subscriptions: relative dates, merged feed and bounded concurrency", async () => {
	const { ageSeconds, mergeFeed, mapLimit } = await import("../web/feed.js");
	assert.equal(ageSeconds("3 days ago"), 3 * 86400);
	assert.equal(ageSeconds("Streamed 2 weeks ago"), 2 * 604800);
	assert.equal(ageSeconds("1 year ago"), 31557600);
	assert.equal(ageSeconds(null), Number.POSITIVE_INFINITY);
	assert.ok(ageSeconds("5 hours ago") < ageSeconds("1 day ago"));

	const vid = (id: string, published: string, extra = {}) => ({ type: "video", id, title: id, published, channel: null, ...extra });
	const a = { name: "A", id: "UCa" };
	const b = { name: "B", id: "UCb" };
	const feed = mergeFeed([
		{ channel: a, results: [vid("a1aaaaaaaaa", "2 hours ago"), vid("a2aaaaaaaaa", "3 days ago"), vid("a3aaaaaaaaa", "", { upcoming: true })] },
		{ channel: b, results: [vid("b1bbbbbbbbb", "1 day ago"), { type: "short", id: "s1sssssssss" }, vid("a1aaaaaaaaa", "2 hours ago")] },
	]);
	assert.deepEqual(feed.map((v: { id: string }) => v.id), ["a1aaaaaaaaa", "b1bbbbbbbbb", "a2aaaaaaaaa"], "newest first, no shorts/upcoming/duplicates");
	assert.equal(feed[1].channel.name, "B", "channel filled in from the page");
	assert.equal(mergeFeed([{ channel: a, results: Array.from({ length: 10 }, (_, i) => vid(`x${i}xxxxxxxxx`, `${i} days ago`)) }], 4).length, 4);

	let inFlight = 0;
	let peak = 0;
	const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n: number) => {
		peak = Math.max(peak, ++inFlight);
		await new Promise((r) => setTimeout(r, 5));
		inFlight--;
		if (n === 3) throw new Error("boom");
		return n * 10;
	});
	assert.equal(peak, 2);
	assert.deepEqual(out, [10, 20, null, 40, 50, 60]);
});

test("parser: lockup metadata rows on channel pages vs search", async () => {
	const { parseSearchResponse } = await import("../src/lib/parse.ts");
	const part = (content: string) => ({ text: { content } });
	const lockup = (id: string, rows: string[][]) => ({
		lockupViewModel: {
			contentId: id,
			contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
			metadata: { lockupMetadataViewModel: { title: { content: `t-${id}` }, metadata: { contentMetadataViewModel: { metadataRows: rows.map((r) => ({ metadataParts: r.map(part) })) } } } },
		},
	});
	const data = {
		contents: {
			richGridRenderer: {
				contents: [
					{ richItemRenderer: { content: lockup("aaaaaaaaaaa", [["148K views", "2 weeks ago"]]) } },
					{ richItemRenderer: { content: lockup("bbbbbbbbbbb", [["Lofi Girl"], ["1.2M views", "Streamed 3 days ago"]]) } },
				],
			},
		},
	};
	const [channelPage, search] = parseSearchResponse(data).results as Array<{ views: string; published: string; channel: { name: string } | null }>;
	assert.equal(channelPage.views, "148K views");
	assert.equal(channelPage.published, "2 weeks ago");
	assert.equal(channelPage.channel, null, "a views row is not a channel name");
	assert.equal(search.channel?.name, "Lofi Girl");
	assert.equal(search.published, "Streamed 3 days ago");
});
