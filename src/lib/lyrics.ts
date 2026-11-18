// Synced lyrics for /api/lyrics, from LRCLIB (https://lrclib.net — free, no key, open data).
// Mirrors BetterYTS Music's core (plugins.rs / music.rs) so the site and the app agree.

export interface LyricLine {
	time: number;
	text: string;
}

export interface Lyrics {
	synced: LyricLine[];
	plain: string | null;
	instrumental: boolean;
	source: "LRCLIB";
}

/** Parses LRC: "[01:02.34]text", several timestamps per line allowed, metadata tags skipped. */
export function parseLrc(text: string): LyricLine[] {
	const out: LyricLine[] = [];
	for (const raw of text.split(/\r?\n/)) {
		let rest = raw.trim();
		const times: number[] = [];
		for (;;) {
			const m = /^\[(\d+):(\d+(?:\.\d+)?)\]/.exec(rest);
			if (!m) break;
			const sec = Number(m[2]);
			if (sec >= 60) break;
			times.push(Number(m[1]) * 60 + sec);
			rest = rest.slice(m[0].length).trimStart();
		}
		for (const time of times) out.push({ time, text: rest.trim() });
	}
	return out.sort((a, b) => a.time - b.time);
}

const NOISE = ["official", "video", "audio", "lyric", "lyrics", "visualizer", "visualiser", "mv", "m/v", "hd", "hq", "4k", "8k", "music video"];

/** Drops "(Official Video)", "[Lyrics]", "【MV】"; keeps "(Remix)", "(feat. X)". */
export function cleanTitle(title: string): string {
	const stripped = title.replace(/[([【]([^)\]】]*)[)\]】]/g, (whole, inner: string) => {
		const words = inner.toLowerCase().split(/[^a-z0-9/]+/);
		return NOISE.some((n) => words.includes(n) || inner.toLowerCase().trim() === n) ? " " : whole;
	});
	return stripped.replace(/\s+/g, " ").replace(/^[\s|-]+|[\s|-]+$/g, "");
}

export function cleanArtist(name: string): string {
	let n = name.trim();
	for (const suffix of [" - Topic", "VEVO", " Official", "Official"]) {
		if (n.length > suffix.length && n.endsWith(suffix)) n = n.slice(0, -suffix.length).trimEnd();
	}
	return n;
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** "Artist - Song (Official Video)" on Artist's channel → { artist, track }. */
export function songOf(title: string, channel: string): { artist: string; track: string } {
	const artist = cleanArtist(channel);
	const track = cleanTitle(title);
	const auto = channel.endsWith(" - Topic") || channel.endsWith("VEVO");
	const m = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(track);
	if (m) {
		const [l, a] = [squash(m[1]), squash(artist)];
		if ((l && a && (l.includes(a) || a.includes(l))) || auto) return { artist: l === a && !channel.endsWith("VEVO") ? artist : m[1].trim(), track: m[2].trim() };
	}
	return { artist, track: track || title.trim() };
}

interface LrclibRecord {
	syncedLyrics?: string | null;
	plainLyrics?: string | null;
	instrumental?: boolean;
	duration?: number;
}

function fromRecord(r: LrclibRecord): Lyrics {
	return {
		synced: r.syncedLyrics ? parseLrc(r.syncedLyrics) : [],
		plain: r.plainLyrics || null,
		instrumental: !!r.instrumental,
		source: "LRCLIB",
	};
}

/** Best search hit: synced lyrics with a matching length first. */
export function pickRecord(list: LrclibRecord[], duration?: number): LrclibRecord | null {
	const close = (r: LrclibRecord) => !duration || typeof r.duration !== "number" || Math.abs(r.duration - duration) <= 4;
	return list.find((r) => close(r) && r.syncedLyrics) ?? list.find(close) ?? list[0] ?? null;
}

const UA = "BetterYTS/1.0 (https://yts.foulfoxhacks.dev)";

export async function lrclib(track: string, artist: string, duration?: number): Promise<Lyrics | null> {
	const get = async (path: string): Promise<unknown> => {
		const res = await fetch(`https://lrclib.net/api/${path}`, { headers: { "User-Agent": UA } });
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`LRCLIB returned HTTP ${res.status}`);
		return res.json();
	};
	const q = new URLSearchParams({ track_name: track, artist_name: artist });
	if (duration) q.set("duration", String(Math.round(duration)));
	const exact = (await get(`get?${q}`)) as LrclibRecord | null;
	if (exact) return fromRecord(exact);
	q.delete("duration");
	const list = (await get(`search?${q}`)) as LrclibRecord[] | null;
	const best = Array.isArray(list) ? pickRecord(list, duration) : null;
	return best ? fromRecord(best) : null;
}
