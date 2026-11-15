// Community add-ons:
//   SponsorBlock        https://sponsor.ajay.app          (segments, CC BY-NC-SA 4.0)
//   DeArrow             https://dearrow.ajay.app          (crowd-sourced titles/thumbnails, CC BY-NC-SA 4.0)
//   Return YouTube Dislike  https://returnyoutubedislike.com (estimated dislikes)
//   YouTube autocomplete (suggestqueries.google.com)

import type { Branding, Segment, Votes } from "./types.ts";

// biome-ignore lint: upstream JSON is untyped
type J = any;

export const USER_AGENT = "BetterYTS/1.0 (+https://github.com/foulfoxhacks/betteryts)";
const SPONSORBLOCK = "https://sponsor.ajay.app";
const DEARROW_THUMBS = "https://dearrow-thumb.ajay.app";
const RYD = "https://returnyoutubedislikeapi.com";

export const SB_CATEGORIES = [
	"sponsor",
	"selfpromo",
	"exclusive_access",
	"interaction",
	"intro",
	"outro",
	"preview",
	"hook",
	"filler",
	"music_offtopic",
	"poi_highlight",
	"chapter",
] as const;
const SB_ACTIONS = ["skip", "mute", "full", "poi", "chapter"];

/** GET with edge caching of the upstream response (Workers `cf` options are ignored outside Workers). */
async function getJson(url: string, cacheTtl: number): Promise<{ status: number; body: J }> {
	const res = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		cf: { cacheTtl, cacheEverything: true },
	} as RequestInit);
	if (!res.ok) return { status: res.status, body: null };
	return { status: res.status, body: await res.json() };
}

async function sha256Hex(s: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SponsorBlock segments. Uses the k-anonymity hash-prefix endpoint so SponsorBlock never
 * learns exactly which video was looked up.
 */
export async function sponsorSegments(id: string, categories: readonly string[] = SB_CATEGORIES): Promise<Segment[]> {
	const prefix = (await sha256Hex(id)).slice(0, 4);
	const url =
		`${SPONSORBLOCK}/api/skipSegments/${prefix}` +
		`?categories=${encodeURIComponent(JSON.stringify(categories))}` +
		`&actionTypes=${encodeURIComponent(JSON.stringify(SB_ACTIONS))}`;
	const { status, body } = await getJson(url, 300);
	if (status === 404 || !Array.isArray(body)) return [];
	const entry = body.find((e: J) => e?.videoID === id);
	if (!entry || !Array.isArray(entry.segments)) return [];
	return entry.segments
		.map(
			(s: J): Segment => ({
				category: s.category,
				action: s.actionType,
				start: Number(s.segment?.[0]) || 0,
				end: Number(s.segment?.[1]) || 0,
				uuid: s.UUID,
				votes: Number(s.votes) || 0,
				locked: !!s.locked,
				videoDuration: Number(s.videoDuration) || null,
				...(s.description ? { description: String(s.description) } : {}),
			}),
		)
		.sort((a: Segment, b: Segment) => a.start - b.start);
}

export async function dislikes(id: string): Promise<Votes | null> {
	const { body } = await getJson(`${RYD}/votes?videoId=${encodeURIComponent(id)}`, 600);
	if (!body || typeof body !== "object") return null;
	return {
		likes: Number(body.likes) || 0,
		dislikes: Number(body.dislikes) || 0,
		rating: typeof body.rating === "number" ? body.rating : null,
		viewCount: typeof body.viewCount === "number" ? body.viewCount : null,
		deleted: !!body.deleted,
	};
}

/** DeArrow marks "keep this word's casing" with a leading ">"; strip the markers for display. */
export function cleanDeArrowTitle(title: string): string {
	return title.replace(/(^|\s)>(?=\S)/g, "$1").trim();
}

export function pickBranding(id: string, body: J): Branding {
	const titles: J[] = Array.isArray(body?.titles) ? body.titles : [];
	const thumbs: J[] = Array.isArray(body?.thumbnails) ? body.thumbnails : [];
	const title = titles.find((t) => !t?.original && (t?.locked || (t?.votes ?? 0) >= 0) && t?.title);
	const thumb = thumbs.find((t) => !t?.original && (t?.locked || (t?.votes ?? 0) >= 0) && typeof t?.timestamp === "number");
	return {
		title: title ? cleanDeArrowTitle(String(title.title)) : null,
		thumbnail: thumb ? `${DEARROW_THUMBS}/api/v1/getThumbnail?videoID=${encodeURIComponent(id)}&time=${thumb.timestamp}` : null,
		thumbnailTime: thumb ? thumb.timestamp : null,
	};
}

export async function branding(id: string): Promise<Branding | null> {
	const { body } = await getJson(`${SPONSORBLOCK}/api/branding?videoID=${encodeURIComponent(id)}`, 900);
	if (!body) return null;
	const b = pickBranding(id, body);
	return b.title || b.thumbnail ? b : null;
}

export async function suggestions(q: string, hl: string, gl: string): Promise<string[]> {
	const url =
		`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&ie=utf-8&oe=utf-8` +
		`&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&q=${encodeURIComponent(q)}`;
	const { body } = await getJson(url, 3600);
	return Array.isArray(body?.[1]) ? body[1].filter((s: J) => typeof s === "string").slice(0, 10) : [];
}
