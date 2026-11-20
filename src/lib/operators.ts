// Search operators: power-user syntax inside the query itself, so it works the same on the site,
// in the JSON API and in VRChat redirect URLs (which only have a single text box).
//
//   channel:@handle  channel:"Two Words"   only results from that channel
//   -channel:name                           never results from that channel
//   -word  -"some phrase"                   drop results whose title or channel has it
//   duration:short|medium|long  (or short/medium/long:true)
//   sort:date|views|rating   upload:hour|today|week|month|year   type:video|channel|playlist
//   is:4k  4k:true  has:subtitles  is:live  hd hdr cc 360 vr180 3d (as is:… or …:true)
//   -shorts  shorts:no|only
//   after:2026-01-01  before:2025-12-31     by upload date (YouTube only gives "3 weeks ago",
//                                           so a result is kept when its date range could match)
//
// Anything else stays in the query sent to YouTube. Unknown "x:y" tokens are left as text.

import { FEATURES } from "./innertube.ts";
import type { SearchFilters, VideoItem } from "./types.ts";

export interface Operators {
	/** What's left to send to YouTube. */
	query: string;
	filters: Partial<SearchFilters>;
	channels: string[];
	excludeChannels: string[];
	exclude: string[];
	/** false: no Shorts; "only": only Shorts. */
	shorts?: false | "only";
	after?: number;
	before?: number;
	/** True if any operator was found (results need filtering or filters changed). */
	any: boolean;
}

const DURATIONS = ["short", "medium", "long"] as const;
const SORTS = ["relevance", "rating", "date", "views"] as const;
const UPLOADS = ["hour", "today", "week", "month", "year"] as const;
const TYPES = ["all", "video", "channel", "playlist", "movie"] as const;
const TRUE = new Set(["true", "yes", "1", "on"]);

const oneOf = <T extends string>(v: string, list: readonly T[]): T | undefined => (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** Splits on spaces, keeping "quoted phrases" (and key:"quoted values") together. */
function tokens(q: string): string[] {
	return q.match(/-?[^\s"]*"[^"]*"?|\S+/g) ?? [];
}

const unquote = (s: string) => s.replace(/^"|"$/g, "").trim();
const norm = (s: string) => s.toLowerCase().replace(/^@/, "").replace(/\s+/g, " ").trim();

function parseDate(s: string): number | undefined {
	const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(s);
	if (!m) return undefined;
	const t = Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1));
	return Number.isFinite(t) ? t : undefined;
}

export function parseOperators(q: string): Operators {
	const ops: Operators = { query: "", filters: {}, channels: [], excludeChannels: [], exclude: [], any: false };
	const keep: string[] = [];
	const features = new Set<string>();
	for (const tok of tokens(q)) {
		const neg = tok.startsWith("-") && tok.length > 1;
		const body = neg ? tok.slice(1) : tok;
		const m = /^([a-z0-9]+):(.+)$/i.exec(body);
		const key = m?.[1].toLowerCase();
		const val = m ? unquote(m[2]) : "";
		const lv = val.toLowerCase();
		let used = true;

		if (key === "channel" && val) (neg ? ops.excludeChannels : ops.channels).push(norm(val));
		else if (neg && !m && /^shorts?$/i.test(body)) ops.shorts = false;
		else if (key === "shorts" && !neg) {
			if (lv === "only") ops.shorts = "only";
			else if (["no", "false", "off", "0"].includes(lv)) ops.shorts = false;
			else used = false;
		} else if (key === "duration" && !neg && oneOf(lv, DURATIONS)) ops.filters.duration = oneOf(lv, DURATIONS);
		else if (key && oneOf(key, DURATIONS) && !neg && TRUE.has(lv)) ops.filters.duration = oneOf(key, DURATIONS);
		else if (key === "sort" && !neg && oneOf(lv, SORTS)) ops.filters.sort = oneOf(lv, SORTS);
		else if (key === "upload" && !neg && oneOf(lv, UPLOADS)) ops.filters.upload = oneOf(lv, UPLOADS);
		else if (key === "type" && !neg && oneOf(lv, TYPES)) ops.filters.type = oneOf(lv, TYPES);
		else if ((key === "is" || key === "has") && !neg && lv in FEATURES) features.add(lv);
		else if (key && key in FEATURES && !neg && TRUE.has(lv)) features.add(key);
		else if ((key === "after" || key === "before") && !neg && parseDate(val) !== undefined) {
			if (key === "after") ops.after = parseDate(val);
			else ops.before = parseDate(val);
		} else if (neg && !m) {
			const word = unquote(body);
			if (word) ops.exclude.push(word.toLowerCase());
		} else used = false;

		if (used) ops.any = true;
		else keep.push(tok);
	}
	if (features.size) ops.filters.features = [...features];
	// Help YouTube find the channel's videos: its name joins the query (handles without the @).
	const words = [...keep, ...ops.channels.map((c) => (c.includes(" ") ? `"${c}"` : c))];
	ops.query = words.join(" ").trim();
	return ops;
}

/** Filters from the URL win over operators in the query. */
export function mergeFilters(fromQuery: Partial<SearchFilters>, fromUrl: SearchFilters): SearchFilters {
	const out: SearchFilters = { ...fromUrl };
	if (fromQuery.duration && !fromUrl.duration) out.duration = fromQuery.duration;
	if (fromQuery.sort && !fromUrl.sort) out.sort = fromQuery.sort;
	if (fromQuery.upload && !fromUrl.upload) out.upload = fromQuery.upload;
	if (fromQuery.type && (!fromUrl.type || fromUrl.type === "all")) out.type = fromQuery.type;
	if (fromQuery.features?.length) out.features = [...new Set([...(fromUrl.features ?? []), ...fromQuery.features])];
	return out;
}

const DAY = 86_400_000;
const UNIT_DAYS: Record<string, number> = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.44, year: 365.25 };

/** The range of upload times "3 weeks ago" could mean, or null if the text can't be read. */
export function publishedRange(text: string | null, now = Date.now()): [number, number] | null {
	const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text ?? "");
	if (!m) return null;
	const n = Number(m[1]);
	const unit = UNIT_DAYS[m[2].toLowerCase()];
	return [now - (n + 1) * unit * DAY, now - n * unit * DAY];
}

/** Letters and digits only: "@LofiGirl", "lofigirl" and "Lofi Girl" are the same channel. */
const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function channelMatches(v: VideoItem, wanted: string): boolean {
	const c = v.channel;
	if (!c) return false;
	const w = compact(wanted);
	// Search results rarely include the @handle, so names match too, ignoring spaces and case.
	return !!w && [c.name, c.handle, c.id].some((x) => x && compact(x) === w);
}

/** Applies the operators YouTube can't: channels, excluded words, Shorts and dates. */
export function matchesOperators(item: { type: string }, ops: Operators, now = Date.now()): boolean {
	if (item.type !== "video" && item.type !== "short") {
		// A channel result is "by" itself; a playlist or mix is by its owner (mixes: "YouTube").
		const it = item as { title?: string; handle?: string | null; id?: string; channel?: VideoItem["channel"] };
		const t = String(it.title ?? "").toLowerCase();
		const owners = item.type === "channel" ? [it.title, it.handle, it.id] : [it.channel?.name, it.channel?.handle, it.channel?.id];
		const isBy = (c: string) => owners.some((x) => x && compact(x) === compact(c));
		if (ops.channels.length && !ops.channels.some(isBy)) return false;
		if (ops.excludeChannels.some(isBy)) return false;
		return !ops.exclude.some((w) => t.includes(w));
	}
	const v = item as unknown as VideoItem;
	if (ops.channels.length && !ops.channels.some((c) => channelMatches(v, c))) return false;
	if (ops.excludeChannels.some((c) => channelMatches(v, c))) return false;
	const text = `${v.title ?? ""} ${v.channel?.name ?? ""}`.toLowerCase();
	if (ops.exclude.some((w) => text.includes(w))) return false;
	if (ops.shorts === false && v.isShort) return false;
	if (ops.shorts === "only" && !v.isShort) return false;
	if (ops.after !== undefined || ops.before !== undefined) {
		const r = publishedRange(v.published, now);
		if (r) {
			if (ops.after !== undefined && r[1] < ops.after) return false;
			if (ops.before !== undefined && r[0] > ops.before + DAY) return false;
		}
	}
	return true;
}
