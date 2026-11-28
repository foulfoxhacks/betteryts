// Smart playlists on the website, shared with BetterYTS Music.
//
// A smart playlist is a rule, not a list: it fills itself from your favorites, playlists and
// history. The built-in ones match the app's; your own rules come from the app (or another
// browser) through backups and sync, kept in the "music" section untouched. The website has no
// play counts, so "played N times" reads as "in your history" here.

const KEY = "betteryts.music.v1";
const DAY = 86_400_000;

/** The app-only backup section ({ smart: [{ id, name, rule }], … }), kept verbatim for round trips. */
export const music = {
	get() {
		try {
			const v = JSON.parse(localStorage.getItem(KEY) || "null");
			return v && typeof v === "object" ? v : {};
		} catch {
			return {};
		}
	},
	save(v) {
		try {
			localStorage.setItem(KEY, JSON.stringify(v && typeof v === "object" ? v : {}));
		} catch {
			/* storage full or blocked */
		}
	},
};

/** "3:33" / "1:02:05" → seconds, or null. */
export function seconds(d) {
	if (typeof d !== "string" || !/^\d+(:\d{1,2}){1,2}$/.test(d)) return null;
	return d.split(":").reduce((a, n) => a * 60 + Number(n), 0);
}

export const BUILT_INS = [
	{ id: "recently-liked", name: "Recently liked", description: "The songs you liked last", rule: { source: "favorites", limit: 50 } },
	{ id: "never-played", name: "Never played", description: "Saved but not played yet", rule: { source: "all", maxPlays: 0, limit: 100 } },
	{ id: "forgotten", name: "Forgotten favourites", description: "Liked songs you haven't played in 60 days", rule: { source: "favorites", minPlays: 1, notPlayedForDays: 60, limit: 50 } },
	{ id: "short", name: "Quick ones", description: "Songs under 3 minutes", rule: { source: "all", maxSeconds: 180, excludeLive: true, limit: 100 } },
	{ id: "long", name: "Long mixes", description: "20 minutes or more", rule: { source: "all", minSeconds: 1200, limit: 100 } },
];

/** Runs a rule (the app's format) over the library. Disliked videos never appear. */
export function evaluate(lib, rule = {}, now = Date.now()) {
	const r = { source: "all", sort: "natural", limit: 100, ...rule };
	const lastPlayed = new Map((lib.history ?? []).map((h) => [h.id, h.at ?? 0]));
	const disliked = new Set((lib.disliked ?? []).map((v) => v.id));
	const pools = {
		favorites: lib.favorites ?? [],
		history: lib.history ?? [],
		playlists: (lib.playlists ?? []).flatMap((p) => p.items ?? []),
		played: lib.history ?? [],
	};
	const source = r.source === "all" ? [...pools.favorites, ...pools.history, ...pools.playlists] : pools[r.source] ?? [];
	const seen = new Set();
	const has = (hay, needle) => !needle || String(hay || "").toLowerCase().includes(String(needle).toLowerCase());
	let out = source.filter((v) => v?.id && !seen.has(v.id) && seen.add(v.id)).filter((v) => {
		const secs = seconds(v.duration);
		const plays = lastPlayed.has(v.id) ? 1 : 0;
		const last = lastPlayed.get(v.id);
		return (r.minSeconds == null || (secs != null && secs >= r.minSeconds))
			&& (r.maxSeconds == null || (secs != null && secs <= r.maxSeconds))
			&& has(v.channel, r.artist) && has(v.title, r.title)
			&& (r.minPlays == null || plays >= Math.min(r.minPlays, 1))
			&& (r.maxPlays == null || plays <= r.maxPlays)
			&& (r.playedWithinDays == null || (last != null && now - last <= r.playedWithinDays * DAY))
			&& (r.notPlayedForDays == null || last == null || now - last >= r.notPlayedForDays * DAY)
			&& !(r.excludeLive && v.duration === "LIVE")
			&& !disliked.has(v.id);
	});
	const by = {
		title: (a, b) => a.title.localeCompare(b.title),
		artist: (a, b) => a.channel.localeCompare(b.channel) || a.title.localeCompare(b.title),
		shortest: (a, b) => (seconds(a.duration) ?? 1e9) - (seconds(b.duration) ?? 1e9),
		longest: (a, b) => (seconds(b.duration) ?? 0) - (seconds(a.duration) ?? 0),
		recentlyPlayed: (a, b) => (lastPlayed.get(b.id) ?? 0) - (lastPlayed.get(a.id) ?? 0),
	}[r.sort];
	if (by) out = [...out].sort(by);
	return out.slice(0, Math.min(Math.max(r.limit || 100, 1), 500));
}

/** Built-ins with songs, then the user's own rules (from the app or another browser). */
export function smartLists(lib, now = Date.now()) {
	const mine = (music.get().smart ?? []).filter((s) => s && typeof s.name === "string" && s.rule && typeof s.rule === "object").map((s) => ({ id: s.id, name: s.name.slice(0, 80), description: "Your smart playlist", rule: s.rule, mine: true }));
	return [...mine, ...BUILT_INS].map((s) => ({ ...s, videos: evaluate(lib, s.rule, now) })).filter((s) => s.mine || s.videos.length);
}
