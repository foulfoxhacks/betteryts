// The sideload app's update manifest, built from the app repository's latest GitHub Release.
import assert from "node:assert/strict";
import { test } from "node:test";

import { APK_PATH, manifest, PACKAGE, SIGNER_SHA256 } from "../src/lib/app-update.ts";

const SHA = "a".repeat(64);
function github(overrides: { sums?: string; info?: string; assets?: string[] } = {}) {
	const assets = (overrides.assets ?? ["app-sideload-release.apk", "SHA256SUMS.txt", "BUILD-INFO.txt"]).map((name) => ({ name, size: name.endsWith(".apk") ? 15_000_000 : 200, browser_download_url: `https://github.com/dl/${name}` }));
	return (async (url: string) => {
		if (url.includes("/releases/latest")) return Response.json({ tag_name: "v0.10.0-build.30", body: "What's new\r\n\r\n\r\n- Sync", published_at: "2026-11-28T00:00:00Z", assets });
		if (url.endsWith("SHA256SUMS.txt")) return new Response(overrides.sums ?? `${SHA}  app-sideload-release.apk\nffff  other.aab\n`);
		if (url.endsWith("BUILD-INFO.txt")) return new Response(overrides.info ?? "Version: 0.10.0\nVersionCode: 1030\nBuild: 30\n");
		return new Response("missing", { status: 404 });
	}) as typeof fetch;
}

test("app update: manifest from the latest release", async () => {
	const m = await manifest("https://yts.foulfoxhacks.dev", github());
	assert.deepEqual(m, {
		packageName: PACKAGE,
		versionCode: 1030,
		versionName: "0.10.0",
		notes: "What's new\n\n- Sync",
		released: "2026-11-28T00:00:00Z",
		signerSha256: SIGNER_SHA256,
		apk: { url: `https://yts.foulfoxhacks.dev${APK_PATH}`, size: 15_000_000, sha256: SHA },
	});
});

test("app update: no manifest when a release lacks what the updater checks", async () => {
	assert.equal(await manifest("https://x", github({ assets: ["app-sideload-release.apk", "SHA256SUMS.txt"] })), null, "no BUILD-INFO (no versionCode)");
	assert.equal(await manifest("https://x", github({ sums: "nothing useful" })), null, "no hash for the APK");
	assert.equal(await manifest("https://x", github({ info: "Version: 0.10.0\n" })), null, "older releases without VersionCode");
	assert.equal(await manifest("https://x", github({ assets: ["app-play-release.aab"] })), null, "no sideload APK");
	assert.equal(await manifest("https://x", (async () => new Response("rate limited", { status: 403 })) as typeof fetch), null, "GitHub unreachable");
});
