// BetterYTS Music (sideload build) self-update manifest, built from the app repository's latest
// GitHub Release: every passing build of its main branch publishes one (signed APK, SHA256SUMS.txt,
// BUILD-INFO.txt). The app's updater (update/Updater.kt) checks the package name, a higher
// versionCode, the signing certificate, the size and SHA-256 before installing anything, and only
// downloads from this host, so the APK is streamed through /app/BetterYTS-Music-latest.apk.

export const RELEASES = "https://api.github.com/repos/foulfoxhacks/betteryts-music/releases/latest";
export const APK_PATH = "/app/BetterYTS-Music-latest.apk";
export const PACKAGE = "dev.foulfoxhacks.betteryts.music";
/** SHA-256 of the release signing certificate (unchanged since 0.9.x). */
export const SIGNER_SHA256 = "b77d81c3041f987ebf26313c3876829bff6f1c16b9e897afa6a8f7e70814622c";
const APK_NAME = "app-sideload-release.apk";

type Asset = { name: string; size: number; browser_download_url: string };
export type Release = { tag_name: string; name?: string; body?: string; published_at?: string; assets: Asset[] };

const GH = { "User-Agent": "BetterYTS-Worker", Accept: "application/vnd.github+json" };

/** The latest release, or null if GitHub can't be reached or it has no sideload APK. */
export async function latestRelease(f: typeof fetch = fetch): Promise<Release | null> {
	const res = await f(RELEASES, { headers: GH });
	if (!res.ok) return null;
	const r = (await res.json()) as Release;
	return Array.isArray(r?.assets) && r.assets.some((a) => a.name === APK_NAME) ? r : null;
}

async function textAsset(r: Release, name: string, f: typeof fetch): Promise<string | null> {
	const a = r.assets.find((x) => x.name === name);
	if (!a || a.size > 64_000) return null;
	const res = await f(a.browser_download_url, { headers: { "User-Agent": GH["User-Agent"] } });
	return res.ok ? res.text() : null;
}

/** The update manifest for the app, or null when the release lacks what the updater needs. */
export async function manifest(origin: string, f: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
	const r = await latestRelease(f);
	if (!r) return null;
	const apk = r.assets.find((a) => a.name === APK_NAME)!;
	const [sums, info] = await Promise.all([textAsset(r, "SHA256SUMS.txt", f), textAsset(r, "BUILD-INFO.txt", f)]);
	const sha = sums?.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === APK_NAME)?.[0]?.toLowerCase();
	const code = Number(/^VersionCode:\s*(\d+)\s*$/m.exec(info ?? "")?.[1]);
	const name = /^Version:\s*(\S+)\s*$/m.exec(info ?? "")?.[1] ?? r.tag_name.replace(/^v/, "");
	if (!sha || !/^[0-9a-f]{64}$/.test(sha) || !Number.isInteger(code) || code <= 0) return null;
	const notes = (r.body ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 600) || `BetterYTS Music ${name}`;
	return {
		packageName: PACKAGE,
		versionCode: code,
		versionName: name,
		notes,
		released: r.published_at ?? null,
		signerSha256: SIGNER_SHA256,
		apk: { url: `${origin}${APK_PATH}`, size: apk.size, sha256: sha },
	};
}

/** Streams the latest sideload APK from GitHub (the updater verifies size, hash and signature). */
export async function apkResponse(f: typeof fetch = fetch): Promise<Response | null> {
	const r = await latestRelease(f);
	const a = r?.assets.find((x) => x.name === APK_NAME);
	if (!a) return null;
	const res = await f(a.browser_download_url, { headers: { "User-Agent": GH["User-Agent"] } });
	if (!res.ok || !res.body) return null;
	return new Response(res.body, {
		headers: {
			"Content-Type": "application/vnd.android.package-archive",
			"Content-Length": String(a.size),
			"Content-Disposition": `attachment; filename="BetterYTS-Music-${r!.tag_name}.apk"`,
			"Cache-Control": "public, max-age=600",
		},
	});
}
