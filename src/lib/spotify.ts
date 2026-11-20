// Spotify playlist/album import: read the public embed page (no API keys, works for Spotify's own
// playlists too), then match each track to a YouTube video with matchScore().

import { cleanArtist } from "./lyrics.ts";
import type { VideoItem } from "./types.ts";

// biome-ignore lint: Spotify page JSON is untyped
type J = any;

export type SpotifyKind = "playlist" | "album";

export interface SpotifyTrack {
	spotifyId: string | null;
	title: string;
	artists: string[];
	durationMs: number | null;
	explicit: boolean;
}

export interface SpotifyCollection {
	kind: SpotifyKind;
	id: string;
	name: string;
	owner: string | null;
	image: string | null;
	tracks: SpotifyTrack[];
	/** The embed page lists at most ~100 tracks; true when the list may be cut short. */
	mayBeTruncated: boolean;
}

const BASE62 = /^[A-Za-z0-9]{22}$/;

/** Accepts open.spotify.com links (any locale prefix), spotify: URIs, or a bare playlist ID. */
export function spotifyRef(input: string): { kind: SpotifyKind; id: string } | null {
	const s = input.trim();
	const uri = /^spotify:(playlist|album):([A-Za-z0-9]{22})$/.exec(s);
	if (uri) return { kind: uri[1] as SpotifyKind, id: uri[2] };
	const url = /^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})/i.exec(s);
	if (url) return { kind: url[1].toLowerCase() as SpotifyKind, id: url[2] };
	if (BASE62.test(s)) return { kind: "playlist", id: s };
	return null;
}

export class SpotifyError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** Pulls the playlist/album out of an embed page's __NEXT_DATA__. */
export function parseEmbed(html: string, kind: SpotifyKind, id: string): SpotifyCollection {
	const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
	if (!m) throw new SpotifyError("Spotify changed its page; the importer needs an update", 502);
	let data: J;
	try {
		data = JSON.parse(m[1]);
	} catch {
		throw new SpotifyError("Couldn't read Spotify's page", 502);
	}
	const e: J = data?.props?.pageProps?.state?.data?.entity;
	if (!e || !Array.isArray(e.trackList)) throw new SpotifyError("Playlist not found or private", 404);
	const tracks: SpotifyTrack[] = e.trackList
		.filter((t: J) => typeof t?.title === "string" && t.title.trim())
		.map((t: J) => ({
			spotifyId: typeof t.uri === "string" ? (t.uri.split(":").pop() ?? null) : null,
			title: String(t.title).trim(),
			artists: String(t.subtitle ?? "")
				.split(",")
				.map((a) => a.trim())
				.filter(Boolean),
			durationMs: typeof t.duration === "number" && t.duration > 0 ? t.duration : null,
			explicit: !!t.isExplicit,
		}));
	const sources: J[] = e.coverArt?.sources ?? e.visualIdentity?.image ?? [];
	return {
		kind,
		id,
		name: String(e.name ?? e.title ?? "Spotify playlist"),
		owner: typeof e.subtitle === "string" ? e.subtitle : null,
		image: sources.find((x) => typeof x?.url === "string")?.url ?? null,
		tracks,
		mayBeTruncated: kind === "playlist" && tracks.length >= 100,
	};
}

export async function fetchSpotify(kind: SpotifyKind, id: string): Promise<SpotifyCollection> {
	const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36",
			"Accept-Language": "en-US,en;q=0.8",
		},
	});
	if (res.status === 404) throw new SpotifyError("Playlist not found or private", 404);
	if (!res.ok) throw new SpotifyError(`Spotify answered HTTP ${res.status}`, 502);
	return parseEmbed(await res.text(), kind, id);
}

// ---------------------------------------------------------------------------------------------
// Matching a Spotify track to a YouTube video
// ---------------------------------------------------------------------------------------------

const words = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 1 || /\d/.test(w));

/** Versions that aren't the studio track unless the Spotify title says so. */
const ALT_VERSIONS = ["live", "cover", "karaoke", "instrumental", "remix", "sped", "slowed", "reverb", "nightcore", "8d", "acoustic", "piano", "loop", "hour", "hours", "reaction", "tutorial", "mashup", "parody"];

export interface MatchInput {
	title: string;
	artist: string;
	/** Seconds. */
	duration?: number;
}

/** 0–100. Above ~60 is a confident match. */
export function matchScore(want: MatchInput, v: VideoItem): number {
	if (v.isShort || v.upcoming || v.live) return 0;
	let score = 0;
	const titleWords = new Set(words(v.title));
	const channel = v.channel?.name ?? "";
	const channelWords = new Set(words(cleanArtist(channel)));
	const wantTitle = words(want.title.replace(/\s*[-(]\s*(feat|ft|with)\.?\s.*$/i, ""));
	const wantArtist = words(want.artist);

	// Title words present
	if (wantTitle.length) score += (30 * wantTitle.filter((w) => titleWords.has(w)).length) / wantTitle.length;
	// Artist named in the title or the channel
	if (wantArtist.length) {
		const hit = wantArtist.filter((w) => titleWords.has(w) || channelWords.has(w)).length / wantArtist.length;
		score += 20 * hit;
	}
	// Official uploads
	if (channel.endsWith(" - Topic")) score += 25;
	else if (/vevo$/i.test(channel)) score += 18;
	else if (v.channel?.verified) score += 8;
	if (/official (audio|music video|video)/i.test(v.title)) score += 6;

	// Length
	if (want.duration && v.durationSeconds) {
		const d = Math.abs(want.duration - v.durationSeconds);
		score += d <= 3 ? 25 : d <= 8 ? 18 : d <= 20 ? 8 : d <= 60 ? -5 : -35;
	}

	// Alternate versions the Spotify track isn't
	const wanted = new Set(words(want.title));
	for (const alt of ALT_VERSIONS) if (titleWords.has(alt) && !wanted.has(alt)) score -= 20;

	return Math.max(0, Math.min(100, Math.round(score)));
}

export function bestMatch(want: MatchInput, candidates: VideoItem[]): { video: VideoItem; score: number }[] {
	return candidates
		.map((video) => ({ video, score: matchScore(want, video) }))
		.filter((c) => c.score > 0)
		.sort((a, b) => b.score - a.score);
}
