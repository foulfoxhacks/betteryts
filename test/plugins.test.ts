// Plugin categories and community manifests. Same cases as BetterYTS Music's core/src/plugins.rs,
// so a manifest gets the same answer on the site and in the app.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain JS module from the site
import { BUILTIN, builtinOn, CATEGORIES, MAX_CODE_BYTES, validateManifest } from "../web/plugins.js";

const PANEL = { id: "song-clock", name: "Song clock", category: "Player", permissions: ["nowPlaying", "panel"], code: "betteryts.on('nowPlaying', n => betteryts.panel(n.title))" };

test("plugins: categories gate their built-ins", () => {
	const settings: Record<string, unknown> = { lyrics: true, sponsorblock: true, categories: {} };
	assert.equal(builtinOn(settings, "lyrics"), true);
	settings.categories = { Player: false };
	assert.equal(builtinOn(settings, "lyrics"), false, "a switched-off category turns its plugins off");
	assert.equal(settings.lyrics, true, "but each plugin keeps its own switch");
	assert.equal(builtinOn(settings, "sponsorblock"), true, "other categories are untouched");
	assert.equal(builtinOn(settings, "nope"), false);
	for (const p of BUILTIN) assert.ok(CATEGORIES.some((c: { id: string }) => c.id === p.category), `${p.id} has a real category`);
});

test("plugins: community manifests stay in safe categories with their own permissions", () => {
	assert.deepEqual(validateManifest(JSON.stringify(PANEL)).permissions, ["nowPlaying", "panel"]);
	const look = validateManifest({ id: "sunset", name: "Sunset", category: "Look", permissions: ["palette"], palette: { accent: "#FF8800", hot: "#aa0044" } });
	assert.equal(look.palette.accent, "#ff8800");

	const refuse = (m: Record<string, unknown>, why: RegExp) => assert.throws(() => validateManifest({ id: "x1x", name: "X", ...m }), why);
	refuse({ category: "Playback", permissions: ["panel"], code: "1" }, /can't be in Playback/);
	refuse({ category: "BetterYTS", permissions: ["panel"], code: "1" }, /can't be in BetterYTS/);
	refuse({ category: "Player", permissions: ["palette"], code: "1" }, /can't ask for `palette`/);
	refuse({ category: "Look", permissions: ["nowPlaying"] }, /can't ask for `nowPlaying`/);
	refuse({ category: "Look", permissions: ["palette"], palette: { accent: "#fff" } }, /colour/);
	refuse({ category: "Look", permissions: ["palette"], palette: { accent: "#ffffff" }, code: "evil()" }, /Only Player/);
	refuse({ category: "Look", permissions: ["palette"], palette: { background: "#ffffff" } }, /can only set/);
	refuse({ category: "Look", permissions: ["palette"], palette: { accent: "red; background:url(//x)" } }, /colour/);
	refuse({ category: "Player", permissions: [] }, /empty/);
	refuse({ category: "Player", permissions: ["panel"] }, /needs `code`/);
	refuse({ category: "Player", permissions: ["panel"], code: "a".repeat(MAX_CODE_BYTES + 1) }, /KB/);
	assert.throws(() => validateManifest({ ...PANEL, id: "lyrics" }), /built-in/);
	assert.throws(() => validateManifest({ ...PANEL, id: "Bad Id" }), /`id`/);
	assert.throws(() => validateManifest("not json"), /JSON/);
	assert.equal(validateManifest({ ...PANEL, name: "  Song\u0007 clock  " }).name, "Song clock", "control characters are stripped");
});
