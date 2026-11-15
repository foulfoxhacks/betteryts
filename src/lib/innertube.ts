// Talks to YouTube's internal "InnerTube" API (the same one youtube.com uses), with an HTML
// scrape of youtube.com/results as a fallback when the JSON endpoint misbehaves.

import { extractInitialData, parseSearchResponse } from "./parse.ts";
import type { ClientOptions, ParsedSearch, SearchFilters } from "./types.ts";

// biome-ignore lint: YouTube JSON is untyped
type J = any;

const YT = "https://www.youtube.com";
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
// SOCS=CAI skips the EU cookie-consent interstitial.
const CONSENT_COOKIE = "SOCS=CAI; CONSENT=YES+";

export class UpstreamError extends Error {
	status: number;
	constructor(message: string, status = 502) {
		super(message);
		this.status = status;
	}
}

// ---------------------------------------------------------------------------------------------
// Search filter encoding. YouTube's "sp" parameter is a base64 protobuf:
//   message SearchParams { int32 sort = 1; Filters filters = 2; }
//   message Filters { int32 upload_date = 1; int32 type = 2; int32 duration = 3; bool <feature> = N; }
// ---------------------------------------------------------------------------------------------

const SORT = { relevance: 0, rating: 1, date: 2, views: 3 } as const;
const UPLOAD = { hour: 1, today: 2, week: 3, month: 4, year: 5 } as const;
const TYPE = { video: 1, channel: 2, playlist: 3, movie: 4 } as const;
const DURATION = { short: 1, long: 2, medium: 3 } as const;
export const FEATURES: Record<string, number> = {
	hd: 4,
	subtitles: 5,
	cc: 6, // Creative Commons
	"3d": 7,
	live: 8,
	purchased: 9,
	"4k": 14,
	"360": 15,
	location: 23,
	hdr: 25,
	vr180: 26,
};

function varint(n: number): number[] {
	const out: number[] = [];
	let v = n >>> 0;
	while (v > 127) {
		out.push((v & 127) | 128);
		v >>>= 7;
	}
	out.push(v);
	return out;
}

const vfield = (num: number, value: number) => [...varint(num << 3), ...varint(value)];
const bfield = (num: number, bytes: number[]) => [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes];

export function encodeSearchParams(f: SearchFilters): string | undefined {
	const filters: number[] = [];
	if (f.upload && f.upload in UPLOAD) filters.push(...vfield(1, UPLOAD[f.upload]));
	if (f.type && f.type !== "all" && f.type in TYPE) filters.push(...vfield(2, TYPE[f.type]));
	if (f.duration && f.duration in DURATION) filters.push(...vfield(3, DURATION[f.duration]));
	for (const feat of f.features ?? []) {
		const num = FEATURES[feat];
		if (num) filters.push(...vfield(num, 1));
	}
	const out: number[] = [];
	if (f.sort && f.sort !== "relevance" && f.sort in SORT) out.push(...vfield(1, SORT[f.sort]));
	if (filters.length) out.push(...bfield(2, filters));
	if (!out.length) return undefined;
	return btoa(String.fromCharCode(...out));
}

function clientContext(o: ClientOptions) {
	return {
		client: { clientName: "WEB", clientVersion: o.clientVersion, hl: o.hl, gl: o.gl, utcOffsetMinutes: 0 },
		user: { lockedSafetyMode: false },
		request: { useSsl: true },
	};
}

function innertubeHeaders(o: ClientOptions): HeadersInit {
	return {
		"Content-Type": "application/json",
		"User-Agent": BROWSER_UA,
		Origin: YT,
		Referer: `${YT}/`,
		Cookie: CONSENT_COOKIE,
		"Accept-Language": `${o.hl},en;q=0.8`,
		"X-Youtube-Client-Name": "1",
		"X-Youtube-Client-Version": o.clientVersion,
	};
}

async function innertube(endpoint: string, body: object, o: ClientOptions): Promise<J> {
	const res = await fetch(`${YT}/youtubei/v1/${endpoint}?prettyPrint=false`, {
		method: "POST",
		headers: innertubeHeaders(o),
		body: JSON.stringify({ context: clientContext(o), ...body }),
	});
	if (!res.ok) throw new UpstreamError(`YouTube ${endpoint} returned HTTP ${res.status}`);
	return res.json();
}

async function htmlSearch(query: string, params: string | undefined, o: ClientOptions): Promise<J> {
	const u = new URL(`${YT}/results`);
	u.searchParams.set("search_query", query);
	if (params) u.searchParams.set("sp", params);
	u.searchParams.set("hl", o.hl);
	u.searchParams.set("gl", o.gl);
	const res = await fetch(u, {
		headers: { "User-Agent": BROWSER_UA, Cookie: CONSENT_COOKIE, "Accept-Language": `${o.hl},en;q=0.8` },
	});
	if (!res.ok) throw new UpstreamError(`YouTube results page returned HTTP ${res.status}`);
	const data = extractInitialData(await res.text());
	if (!data) throw new UpstreamError("Could not find search data in the YouTube results page");
	return data;
}

/**
 * Run a search (or fetch the next page when `continuation` is given).
 * Falls back to scraping the HTML results page if the JSON API fails on a first page.
 */
export async function search(
	query: string,
	filters: SearchFilters,
	o: ClientOptions,
	continuation?: string,
): Promise<ParsedSearch & { source: "innertube" | "html" }> {
	if (continuation) {
		const data = await innertube("search", { continuation }, o);
		return { ...parseSearchResponse(data), source: "innertube" };
	}
	const params = encodeSearchParams(filters);
	try {
		const data = await innertube("search", params ? { query, params } : { query }, o);
		const parsed = parseSearchResponse(data);
		if (parsed.results.length || parsed.next) return { ...parsed, source: "innertube" };
	} catch (err) {
		console.warn("innertube search failed, trying HTML fallback", String(err));
	}
	const data = await htmlSearch(query, params, o);
	return { ...parseSearchResponse(data), source: "html" };
}

export interface VideoDetails {
	id: string;
	title: string | null;
	author: string | null;
	channelId: string | null;
	channelUrl: string | null;
	lengthSeconds: number | null;
	viewCount: number | null;
	description: string | null;
	keywords: string[];
	isLive: boolean;
	publishDate: string | null;
	category: string | null;
	thumbnail: string;
	playable: string | null;
}

/** Best-effort metadata: InnerTube `player` (rich, but sometimes bot-walled) merged with oEmbed (reliable, thin). */
export async function videoDetails(id: string, o: ClientOptions): Promise<VideoDetails> {
	const [player, oembed] = await Promise.allSettled([
		innertube("player", { videoId: id, contentCheckOk: true, racyCheckOk: true }, o),
		fetch(`${YT}/oembed?format=json&url=${encodeURIComponent(`${YT}/watch?v=${id}`)}`, {
			headers: { "User-Agent": BROWSER_UA },
		}).then((r) => (r.ok ? r.json() : null)),
	]);
	const p: J = player.status === "fulfilled" ? player.value : null;
	const e: J = oembed.status === "fulfilled" ? oembed.value : null;
	const vd = p?.videoDetails?.videoId === id ? p.videoDetails : null;
	const mf = p?.microformat?.playerMicroformatRenderer;
	if (!vd && !e) throw new UpstreamError("Video not found or unavailable", 404);
	const num = (s: J) => {
		const n = Number.parseInt(s ?? "", 10);
		return Number.isFinite(n) ? n : null;
	};
	return {
		id,
		title: vd?.title ?? e?.title ?? null,
		author: vd?.author ?? e?.author_name ?? null,
		channelId: vd?.channelId ?? mf?.externalChannelId ?? null,
		channelUrl: e?.author_url ?? (vd?.channelId ? `${YT}/channel/${vd.channelId}` : null),
		lengthSeconds: num(vd?.lengthSeconds),
		viewCount: num(vd?.viewCount),
		description: vd?.shortDescription ?? null,
		keywords: Array.isArray(vd?.keywords) ? vd.keywords : [],
		isLive: !!vd?.isLive || !!mf?.liveBroadcastDetails?.isLiveNow,
		publishDate: mf?.publishDate ?? null,
		category: mf?.category ?? null,
		thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
		playable: p?.playabilityStatus?.status ?? null,
	};
}
