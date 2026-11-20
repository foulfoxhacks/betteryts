// Spotify importer: link parsing, embed parsing, YouTube match scoring.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bestMatch, matchScore, parseEmbed, spotifyRef } from "../src/lib/spotify.ts";

test("spotify: links, URIs and IDs", () => {
	assert.deepEqual(spotifyRef("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123"), { kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
	assert.deepEqual(spotifyRef("https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy"), { kind: "album", id: "4aawyAB9vmqN3uQ7FjRGTy" });
	assert.deepEqual(spotifyRef("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"), { kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
	assert.deepEqual(spotifyRef("open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M"), { kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
	assert.deepEqual(spotifyRef("37i9dQZF1DXcBWIGoYBM5M"), { kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
	assert.equal(spotifyRef("https://open.spotify.com/track/3h5T5JypYU7huFiVYhv1dr"), null, "single tracks aren't collections");
	assert.equal(spotifyRef("https://evil.example/playlist/37i9dQZF1DXcBWIGoYBM5M"), null);
	assert.equal(spotifyRef("not a link"), null);
});

const page = (entity: object) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;

test("spotify: embed page parsing", () => {
	const c = parseEmbed(
		page({
			name: "Road trip",
			subtitle: "Sammy",
			coverArt: { sources: [{ url: "https://i.scdn.co/image/x" }] },
			trackList: [
				{ uri: "spotify:track:aaa", title: "Song A", subtitle: "Artist One, Artist Two", duration: 201000, isExplicit: true },
				{ uri: "spotify:track:bbb", title: "  ", subtitle: "Nobody", duration: 1000 },
				{ title: "Song C", subtitle: "", duration: 0 },
			],
		}),
		"playlist",
		"37i9dQZF1DXcBWIGoYBM5M",
	);
	assert.equal(c.name, "Road trip");
	assert.equal(c.owner, "Sammy");
	assert.equal(c.image, "https://i.scdn.co/image/x");
	assert.equal(c.tracks.length, 2, "blank titles dropped");
	assert.deepEqual(c.tracks[0], { spotifyId: "aaa", title: "Song A", artists: ["Artist One", "Artist Two"], durationMs: 201000, explicit: true });
	assert.deepEqual(c.tracks[1].artists, []);
	assert.equal(c.tracks[1].durationMs, null);
	assert.equal(c.mayBeTruncated, false);
	const big = parseEmbed(page({ name: "x", trackList: Array.from({ length: 100 }, (_, i) => ({ title: `t${i}`, subtitle: "a" })) }), "playlist", "x");
	assert.equal(big.mayBeTruncated, true);
	assert.throws(() => parseEmbed("<html>nothing</html>", "playlist", "x"), /changed its page/);
	assert.throws(() => parseEmbed(page({ name: "x" }), "playlist", "x"), /not found/);
});

const v = (title: string, channel: string, durationSeconds: number | null, extra: object = {}) =>
	({ type: "video", id: title.slice(0, 11).padEnd(11, "x"), title, channel: { name: channel, verified: false }, durationSeconds, isShort: false, upcoming: false, live: false, ...extra }) as never;

test("spotify: match scoring prefers the studio track at the right length", () => {
	const want = { title: "Housewife", artist: "Tate McRae", duration: 209 };
	const official = v("Tate McRae - Housewife (Official Video)", "Tate McRae", 210);
	const topic = v("Housewife", "Tate McRae - Topic", 209);
	const live = v("Tate McRae - Housewife (Live at Glastonbury)", "BBC Music", 260);
	const cover = v("Housewife - Tate McRae (cover)", "Some Singer", 205);
	const hour = v("Tate McRae - Housewife 1 hour loop", "Loops", 3600);
	const other = v("Tate McRae - greedy", "Tate McRae", 131);
	assert.ok(matchScore(want, topic) >= 60, "topic upload is confident");
	assert.ok(matchScore(want, official) >= 60, "official video is confident");
	assert.ok(matchScore(want, live) < matchScore(want, official));
	assert.ok(matchScore(want, cover) < matchScore(want, official));
	assert.ok(matchScore(want, hour) < 35, "hour-long loop rejected");
	assert.ok(matchScore(want, other) < matchScore(want, official), "different song loses");
	assert.equal(matchScore(want, v("Housewife", "Tate McRae - Topic", 209, { isShort: true })), 0, "Shorts never match");
	// A remix is fine when the Spotify title says remix
	const remixWant = { title: "Housewife (Remix)", artist: "Tate McRae", duration: 200 };
	assert.ok(matchScore(remixWant, v("Tate McRae - Housewife (Remix)", "Tate McRae", 200)) >= 60);
	const ranked = bestMatch(want, [cover, live, official, topic, hour]);
	assert.ok([topic, official].includes(ranked[0].video));
	assert.ok(ranked.every((r, i) => i === 0 || r.score <= ranked[i - 1].score), "sorted best first");
});
