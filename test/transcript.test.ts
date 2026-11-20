// Transcripts: json3 parsing and caption track choice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJson3, pickTrack } from "../src/lib/transcript.ts";

test("transcript: json3 events become lines", () => {
	const lines = parseJson3({
		events: [
			{ tStartMs: 0, dDurationMs: 1000 }, // window event, no segs
			{ tStartMs: 18800, dDurationMs: 7160, segs: [{ utf8: "We're no " }, { utf8: "strangers\nto" }] },
			{ tStartMs: 26000, segs: [{ utf8: "\n" }] }, // layout marker
		],
	});
	assert.deepEqual(lines, [{ start: 18.8, dur: 7.16, text: "We're no strangers to" }]);
	assert.deepEqual(parseJson3(null), []);
	assert.deepEqual(parseJson3({ events: "nope" }), []);
});

test("transcript: picking a track", () => {
	const tracks = [
		{ languageCode: "en", kind: "asr" },
		{ languageCode: "de-DE" },
		{ languageCode: "en" },
		{ languageCode: "pt-BR" },
	];
	assert.equal(pickTrack(tracks, null, "en"), tracks[2], "human English beats auto English");
	assert.equal(pickTrack(tracks, "en:asr", "en"), tracks[0], "auto on request");
	assert.equal(pickTrack(tracks, "de", "en"), tracks[1], "language without region");
	assert.equal(pickTrack(tracks, null, "pt"), tracks[3], "the UI language first");
	assert.equal(pickTrack(tracks, "fr", "en"), tracks[2], "unknown language falls back");
	assert.equal(pickTrack([], null, "en"), null);
	assert.equal(pickTrack([{ languageCode: "ko", kind: "asr" }], null, "en")?.languageCode, "ko", "anything beats nothing");
});
