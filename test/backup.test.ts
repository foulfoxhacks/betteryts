// Backups: what's exported, and that imports are checked like any untrusted input.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain JS modules from the site
import { buildBackup, cleanSettings, readBackup } from "../web/backup.js";

const DEFAULTS = { sponsorblock: true, hideShorts: true, region: "", hiddenChannels: "", categories: {}, skip: { sponsor: true } };
const video = { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", channel: "Rick Astley", thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg", duration: "3:33" };

test("backup: round trip", () => {
	const library = {
		favorites: [video],
		history: [{ ...video, at: 1700000000000 }],
		playlists: [{ id: "abc123", name: "Road trip", items: [video], createdAt: 1700000000000 }],
		queue: [video],
		subscriptions: [{ id: "UCuAXFkgsw1L7xaCfnd5JJOw", title: "Rick Astley", handle: "@RickAstleyYT", avatar: null, at: 1 }],
	};
	const plugins = [{ id: "sunset", name: "Sunset", category: "Look", permissions: ["palette"], palette: { accent: "#ff8800" }, enabled: false }];
	const text = JSON.stringify(buildBackup({ settings: { ...DEFAULTS, hideShorts: false }, library, plugins, version: "1.1.0" }));
	const b = readBackup(text, DEFAULTS);
	assert.equal(b.settings.hideShorts, false);
	assert.deepEqual(b.library.favorites[0].id, video.id);
	assert.equal(b.library.history[0].at, 1700000000000);
	assert.equal(b.library.playlists[0].name, "Road trip");
	assert.equal(b.library.subscriptions[0].id, "UCuAXFkgsw1L7xaCfnd5JJOw");
	assert.equal(b.plugins[0].id, "sunset");
	assert.equal(b.plugins[0].enabled, false);
	assert.deepEqual(b.counts, { favorites: 1, history: 1, playlists: 1, subscriptions: 1, queue: 1 });
});

test("backup: imports are checked", () => {
	assert.throws(() => readBackup("nope", DEFAULTS), /expected JSON/);
	assert.throws(() => readBackup(JSON.stringify({ format: "other" }), DEFAULTS), /isn't a BetterYTS backup/);
	assert.throws(() => readBackup(JSON.stringify({ format: "betteryts-backup", version: 9 }), DEFAULTS), /newer version/);

	const evil = readBackup(
		JSON.stringify({
			format: "betteryts-backup",
			version: 1,
			settings: { hideShorts: "yes", region: 5, __proto__x: true, unknown: 1, skip: { sponsor: false, "bad key!": true, x: "str" } },
			library: {
				favorites: [{ id: "javascript:x", title: "x" }, { ...video, thumbnail: "javascript:alert(1)" }],
				subscriptions: [{ id: "not-a-channel" }],
				playlists: [{ id: "<img>", name: "x".repeat(500), items: "nope" }],
			},
			plugins: [{ id: "x1x", name: "X", category: "Playback", permissions: ["panel"], code: "1" }],
		}),
		DEFAULTS,
	);
	assert.deepEqual(Object.keys(evil.settings), ["skip"], "wrong types and unknown keys are dropped");
	assert.deepEqual(evil.settings.skip, { sponsor: false });
	assert.equal(evil.library.favorites.length, 1, "bad video IDs are dropped");
	assert.match(evil.library.favorites[0].thumbnail, /^https:\/\/i\.ytimg\.com\//, "unsafe URLs are replaced");
	assert.equal(evil.library.subscriptions.length, 0);
	assert.equal(evil.library.playlists[0].name.length, 80);
	assert.match(evil.library.playlists[0].id, /^[a-z0-9]+$/);
	assert.equal(evil.plugins.length, 0, "plugins go through the manifest rules");
	assert.deepEqual(cleanSettings(null, DEFAULTS), {});
});
