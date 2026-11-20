// The BetterYTS ecosystem: every project, its current version and where to get it.
// yts.foulfoxhacks.dev is the hub; the footer of every page and /ecosystem read /api/ecosystem.
//
// Versions: the site and API come from this file (bump SITE_VERSION on release). The Music app's
// repo is private, so MUSIC_VERSION is bumped here when it ships (keep it equal to versionName in
// betteryts-music/android/app/build.gradle.kts). VRChat package versions are read live from the
// VPM listing, so they're never out of date.

export const SITE_VERSION = "1.1.0";
export const MUSIC_VERSION = "0.9.1";
export const VPM_LISTING = "https://vpm.foulfoxhacks.dev/index.json";

export interface Project {
	id: string;
	name: string;
	kind: string;
	version: string | null;
	description: string;
	url: string;
	source?: string;
	/** Extra links, e.g. "Add to VCC". */
	links?: { text: string; url: string }[];
	packages?: { id: string; name: string; version: string }[];
}

/** Highest version in a VPM package's `versions` map (semver-ish: numeric parts, pre-releases last). */
export function latestVersion(versions: string[]): string | null {
	const parse = (v: string) => {
		const [core, pre] = v.split("-", 2);
		return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
	};
	const cmp = (a: string, b: string) => {
		const x = parse(a);
		const y = parse(b);
		for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
			const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
			if (d) return d;
		}
		if (x.pre === y.pre) return 0;
		if (x.pre === null) return 1; // a release beats its pre-release
		if (y.pre === null) return -1;
		return x.pre < y.pre ? -1 : 1;
	};
	return versions.length ? [...versions].sort(cmp).at(-1)! : null;
}

/** The packages in a VPM listing, each at its latest version. */
export function vpmPackages(listing: unknown): { id: string; name: string; version: string }[] {
	const pkgs = (listing as { packages?: Record<string, { versions?: Record<string, { displayName?: string }> }> })?.packages;
	if (!pkgs || typeof pkgs !== "object") return [];
	return Object.entries(pkgs).flatMap(([id, p]) => {
		const version = latestVersion(Object.keys(p?.versions ?? {}));
		if (!version) return [];
		const name = p.versions?.[version]?.displayName;
		return [{ id, name: typeof name === "string" ? name.slice(0, 60) : id, version }];
	});
}

/** Every project. `listing` is the VPM index (or null if it couldn't be fetched). */
export function ecosystem(listing: unknown | null, build = "dev"): { hub: string; build: string; projects: Project[] } {
	const packages = listing ? vpmPackages(listing) : [];
	const main = packages.find((p) => p.id === "com.foulfoxhacks.betteryts");
	return {
		hub: "https://yts.foulfoxhacks.dev",
		build,
		projects: [
			{
				id: "web",
				name: "BetterYTS Web",
				kind: "Website",
				version: SITE_VERSION,
				description: "Ad-free YouTube search and playback with SponsorBlock, DeArrow, lyrics, a local library, watch-party rooms and plugins.",
				url: "/",
				source: "https://github.com/foulfoxhacks/betteryts",
			},
			{
				id: "api",
				name: "BetterYTS API",
				kind: "JSON API & redirects",
				version: SITE_VERSION,
				description: "Search, video, channel and playlist JSON, VRChat-ready redirects, ProTV playlists and watch-party rooms.",
				url: "/docs",
				source: "https://github.com/foulfoxhacks/betteryts",
			},
			{
				id: "vrchat",
				name: "BetterYTS for VRChat",
				kind: "VRChat packages (VCC)",
				version: main?.version ?? packages[0]?.version ?? null,
				description: "In-world YouTube search, ProTV integration and editor tools for your worlds.",
				url: "https://vpm.foulfoxhacks.dev",
				source: "https://github.com/foulfoxhacks/betteryts-vrchat",
				links: [{ text: "Add to VCC", url: `vcc://vpm/addRepo?url=${encodeURIComponent(VPM_LISTING)}` }],
				packages,
			},
			{
				id: "music",
				name: "BetterYTS Music",
				kind: "Android app (beta)",
				version: MUSIC_VERSION,
				description: "A YouTube Music-style app on the BetterYTS core: background play, synced lyrics, Spotify import and Listen Together rooms.",
				url: "/ecosystem#music",
			},
		],
	};
}
