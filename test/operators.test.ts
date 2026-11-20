// Search operators and the ecosystem/version helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ecosystem, latestVersion, SITE_VERSION, vpmPackages } from "../src/lib/ecosystem.ts";
import { matchesOperators, mergeFilters, parseOperators, publishedRange } from "../src/lib/operators.ts";

const vid = (over: Record<string, unknown> = {}) => ({
	type: "video",
	id: "aaaaaaaaaaa",
	title: "Lofi beats to study to",
	isShort: false,
	published: "2 weeks ago",
	channel: { name: "Lofi Girl", handle: "@LofiGirl", id: "UCSJ4gkVC6NrvII8umztf0Ow" },
	...over,
});

test("operators: parsing", () => {
	const o = parseOperators('lofi channel:@lofigirl -channel:"Chillhop Music" -remix -"1 hour" duration:long sort:date is:4k hd:true -shorts after:2026-01-01');
	assert.equal(o.query, "lofi lofigirl");
	assert.deepEqual(o.channels, ["lofigirl"]);
	assert.deepEqual(o.excludeChannels, ["chillhop music"]);
	assert.deepEqual(o.exclude, ["remix", "1 hour"]);
	assert.equal(o.filters.duration, "long");
	assert.equal(o.filters.sort, "date");
	assert.deepEqual(o.filters.features?.sort(), ["4k", "hd"]);
	assert.equal(o.shorts, false);
	assert.equal(o.after, Date.UTC(2026, 0, 1));
	assert.equal(o.any, true);

	const plain = parseOperators("how to fix a 3:2 aspect ratio");
	assert.equal(plain.any, false, "time-like and unknown key:value text stays a plain search");
	assert.equal(plain.query, "how to fix a 3:2 aspect ratio");
	assert.equal(parseOperators("long:true shorts:only").filters.duration, "long");
	assert.equal(parseOperators("shorts:only").shorts, "only");
	assert.equal(parseOperators("duration:forever").any, false, "bad values are left as text");
});

test("operators: URL filters win, features merge", () => {
	const f = mergeFilters({ duration: "long", sort: "date", features: ["4k"] }, { type: "all", duration: "short", features: ["hd"] });
	assert.equal(f.duration, "short");
	assert.equal(f.sort, "date");
	assert.deepEqual(f.features, ["hd", "4k"]);
});

test("operators: filtering results", () => {
	const now = Date.UTC(2026, 10, 20);
	const o = parseOperators("lofi channel:@lofigirl -remix -shorts");
	assert.ok(matchesOperators(vid(), o, now));
	assert.ok(!matchesOperators(vid({ channel: { name: "Someone Else", handle: "@else", id: "x" } }), o, now));
	assert.ok(!matchesOperators(vid({ title: "Lofi REMIX" }), o, now));
	assert.ok(!matchesOperators(vid({ isShort: true, type: "short" }), o, now));
	assert.ok(matchesOperators(vid(), parseOperators('channel:"lofi girl"'), now), "channel by display name");
	assert.ok(matchesOperators(vid({ channel: { name: "Lofi Girl", handle: null, id: "UCx" } }), parseOperators("channel:@LofiGirl"), now), "a handle matches the name when results have no handle");

	const after = parseOperators("lofi after:2026-11-01");
	assert.ok(matchesOperators(vid({ published: "2 weeks ago" }), after, now));
	assert.ok(!matchesOperators(vid({ published: "3 months ago" }), after, now));
	assert.ok(matchesOperators(vid({ published: null }), after, now), "unknown dates aren't dropped");
	const before = parseOperators("lofi before:2025-01-01");
	assert.ok(!matchesOperators(vid({ published: "2 weeks ago" }), before, now));
	assert.ok(matchesOperators(vid({ published: "Streamed 3 years ago" }), before, now));
	assert.deepEqual(publishedRange("nonsense"), null);
});

test("ecosystem: versions and the VPM listing", () => {
	assert.equal(latestVersion(["1.0.0", "1.0.10", "1.0.2", "1.1.0-beta.1"]), "1.1.0-beta.1");
	assert.equal(latestVersion(["1.1.0-beta.1", "1.1.0"]), "1.1.0", "a release beats its pre-release");
	const listing = { packages: { "com.foulfoxhacks.betteryts": { versions: { "1.0.0": { displayName: "BetterYTS In-World Search" }, "1.0.1": { displayName: "BetterYTS In-World Search" } } } } };
	assert.deepEqual(vpmPackages(listing), [{ id: "com.foulfoxhacks.betteryts", name: "BetterYTS In-World Search", version: "1.0.1" }]);
	const eco = ecosystem(listing, "abc1234");
	assert.equal(eco.projects.find((p) => p.id === "vrchat")?.version, "1.0.1");
	assert.equal(eco.projects.find((p) => p.id === "web")?.version, SITE_VERSION);
	assert.equal(ecosystem(null).projects.find((p) => p.id === "vrchat")?.version, null, "unreachable listing: unknown, not a stale guess");
	assert.deepEqual(vpmPackages({ nope: 1 }), []);
});
