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
