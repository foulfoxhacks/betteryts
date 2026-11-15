// Turns YouTube's InnerTube search JSON into clean, ad-free results.
//
// Instead of hard-coding the (frequently reshuffled) path to the result list, we walk the whole
// tree and pick out the renderers we understand. Ad and promo renderers are dropped wholesale.

import type { Channel, ChannelItem, Item, ParsedSearch, PlaylistItem, VideoItem } from "./types.ts";

// biome-ignore lint: YouTube JSON is untyped
type J = any;

/** Renderers that are ads, promos, or sponsored placements. Never shown, never descended into. */
export const AD_RENDERERS = new Set([
	"adSlotRenderer",
	"adSlotAndLayoutViewModel",
	"inFeedAdLayoutRenderer",
	"promotedSparklesWebRenderer",
	"promotedSparklesTextSearchRenderer",
	"promotedVideoRenderer",
	"compactPromotedVideoRenderer",
	"searchPyvRenderer",
	"bannerPromoRenderer",
	"brandVideoShelfRenderer",
	"brandVideoSingletonRenderer",
	"statementBannerRenderer",
	"movieOfferModuleRenderer",
	"primetimePromoRenderer",
	"mealbarPromoRenderer",
	"compactMovieRenderer",
]);

/** Parts of the response that never contain results; skipping them saves CPU. */
const SKIP_KEYS = new Set(["frameworkUpdates", "topbar", "responseContext", "trackingParams", "header", "loggingDirectives"]);

export function text(node: J): string {
	if (node == null) return "";
	if (typeof node === "string") return node;
	if (typeof node.simpleText === "string") return node.simpleText;
	if (Array.isArray(node.runs)) return node.runs.map((r: J) => r?.text ?? "").join("");
	if (typeof node.content === "string") return node.content;
	return "";
}

function absUrl(u: string | undefined | null): string | null {
	if (!u) return null;
	if (u.startsWith("//")) return `https:${u}`;
	if (u.startsWith("/")) return `https://www.youtube.com${u}`;
	return u;
}

function bestThumb(list: J): string | null {
	if (!Array.isArray(list) || list.length === 0) return null;
	let best = list[0];
	for (const t of list) if ((t?.width ?? 0) > (best?.width ?? 0)) best = t;
	return absUrl(best?.url);
}

/** First value found under `key` anywhere inside `node` (depth-first). */
export function findKey(node: J, key: string, depth = 0): J {
	if (node == null || typeof node !== "object" || depth > 30) return undefined;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findKey(child, key, depth + 1);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}
	if (key in node) return node[key];
	for (const child of Object.values(node)) {
		const hit = findKey(child, key, depth + 1);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

/** "1:02:03" → 3723 */
export function parseDuration(s: string | null | undefined): number | null {
	if (!s) return null;
	const parts = s.trim().split(":").map((p) => Number.parseInt(p, 10));
	if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return null;
	return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** "1,234,567 views" → 1234567. Abbreviated counts ("1.2M") are left to the `views` string. */
export function parseCount(s: string | null | undefined): number | null {
	if (!s) return null;
	const m = /^([\d,.\s]+)\s/.exec(`${s} `);
	if (!m || /[KMB]/i.test(s.replace(/views?|watching|subscribers?/gi, ""))) return null;
	const n = Number.parseInt(m[1].replace(/[^\d]/g, ""), 10);
	return Number.isFinite(n) ? n : null;
}

function channelFromRuns(runsNode: J, extra?: { verified?: boolean; avatar?: string | null }): Channel | null {
	const run = runsNode?.runs?.[0];
	const name = text(runsNode);
	if (!name) return null;
	const browse = run?.navigationEndpoint?.browseEndpoint;
	const path: string | undefined = browse?.canonicalBaseUrl ?? run?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
	return {
		name,
		id: browse?.browseId ?? null,
		url: absUrl(path) ?? (browse?.browseId ? `https://www.youtube.com/channel/${browse.browseId}` : null),
		handle: path?.startsWith("/@") ? decodeURIComponent(path.slice(1)) : null,
		verified: extra?.verified ?? false,
		avatar: extra?.avatar ?? null,
	};
}

function isVerified(badges: J): boolean {
	if (!Array.isArray(badges)) return false;
	return badges.some((b: J) => /VERIFIED|ARTIST/.test(b?.metadataBadgeRenderer?.style ?? ""));
}

function overlayStyle(v: J): string {
	const overlays: J[] = v?.thumbnailOverlays ?? [];
	for (const o of overlays) {
		const s = o?.thumbnailOverlayTimeStatusRenderer?.style;
		if (s) return s;
	}
	return "";
}

export function parseVideoRenderer(v: J): VideoItem | null {
	const id: string | undefined = v?.videoId;
	if (!id) return null;
	const style = overlayStyle(v);
	const navUrl: string = v?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ?? "";
	const isShort = !!v?.navigationEndpoint?.reelWatchEndpoint || navUrl.startsWith("/shorts/") || style === "SHORTS";
	const badgeList: J[] = v?.badges ?? [];
	const badges = badgeList.map((b) => b?.metadataBadgeRenderer?.label).filter(Boolean) as string[];
	const live = style === "LIVE" || badgeList.some((b) => b?.metadataBadgeRenderer?.style === "BADGE_STYLE_TYPE_LIVE_NOW");
	const duration = text(v?.lengthText) || null;
	const views = text(v?.viewCountText) || text(v?.shortViewCountText) || null;
	const avatar = bestThumb(v?.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails);
	const snippet = text(v?.detailedMetadataSnippets?.[0]?.snippetText) || text(v?.descriptionSnippet) || null;
	return {
		type: isShort ? "short" : "video",
		id,
		url: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
		title: text(v?.title),
		thumbnail: bestThumb(v?.thumbnail?.thumbnails) ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
		duration,
		durationSeconds: parseDuration(duration),
		views,
		viewCount: parseCount(text(v?.viewCountText)),
		published: text(v?.publishedTimeText) || null,
		description: snippet,
		channel: channelFromRuns(v?.ownerText ?? v?.longBylineText ?? v?.shortBylineText, { verified: isVerified(v?.ownerBadges), avatar }),
		badges,
		live,
		upcoming: !!v?.upcomingEventData,
		isShort,
	};
}

function parseChannelRenderer(c: J): ChannelItem | null {
	const id: string | undefined = c?.channelId;
	if (!id) return null;
	// YouTube shuffled these fields: the handle now usually lives in subscriberCountText.
	const a = text(c?.subscriberCountText);
	const b = text(c?.videoCountText);
	const handle = [a, b].find((s) => s.startsWith("@")) ?? null;
	const subscribers = [a, b].find((s) => s && !s.startsWith("@")) ?? null;
	const path: string | undefined = c?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl;
	return {
		type: "channel",
		id,
		url: absUrl(path) ?? `https://www.youtube.com/channel/${id}`,
		title: text(c?.title),
		handle,
		thumbnail: bestThumb(c?.thumbnail?.thumbnails),
		subscribers,
		description: text(c?.descriptionSnippet) || null,
		verified: isVerified(c?.ownerBadges),
	};
}

function parsePlaylistRenderer(p: J, kind: "playlist" | "mix"): PlaylistItem | null {
	const id: string | undefined = p?.playlistId;
	if (!id) return null;
	const thumbs = p?.thumbnails?.[0]?.thumbnails ?? p?.thumbnail?.thumbnails;
	return {
		type: kind,
		id,
		url: `https://www.youtube.com/playlist?list=${id}`,
		title: text(p?.title),
		thumbnail: bestThumb(thumbs),
		videoCount: text(p?.videoCountText) || (p?.videoCount ? `${p.videoCount} videos` : null),
		channel: channelFromRuns(p?.longBylineText ?? p?.shortBylineText),
		firstVideoId: p?.navigationEndpoint?.watchEndpoint?.videoId ?? null,
	};
}

/** The newer "lockup" view-model format (used for playlists, mixes, and some video experiments). */
function parseLockup(l: J): Item | null {
	const id: string | undefined = l?.contentId;
	if (!id) return null;
	const meta = l?.metadata?.lockupMetadataViewModel;
	const title = text(meta?.title);
	const rows: J[] = meta?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
	const parts: string[] = rows.flatMap((r) => (r?.metadataParts ?? []).map((p: J) => text(p?.text))).filter(Boolean);
	const sources = findKey(l?.contentImage, "sources");
	const thumbnail = bestThumb(sources);
	const badge = findKey(l?.contentImage, "thumbnailBadgeViewModel");
	const badgeText = badge ? text(badge.text) : "";
	const ctype: string = l?.contentType ?? "";
	if (ctype.includes("VIDEO")) {
		return {
			type: "video",
			id,
			url: `https://www.youtube.com/watch?v=${id}`,
			title,
			thumbnail: thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
			duration: badgeText || null,
			durationSeconds: parseDuration(badgeText),
			views: parts.find((p) => /view|watching/i.test(p)) ?? null,
			viewCount: null,
			published: parts.find((p) => /ago|Streamed|Premiered/i.test(p)) ?? null,
			description: null,
			channel: parts[0] ? { name: parts[0], id: null, url: null, handle: null, verified: false, avatar: null } : null,
			badges: [],
			live: /LIVE/i.test(badgeText),
			upcoming: false,
			isShort: false,
		};
	}
	const isMix = id.startsWith("RD") || /MIX/i.test(ctype);
	const firstVideo = findKey(l?.rendererContext, "watchEndpoint")?.videoId ?? null;
	return {
		type: isMix ? "mix" : "playlist",
		id,
		url: isMix && firstVideo ? `https://www.youtube.com/watch?v=${firstVideo}&list=${id}` : `https://www.youtube.com/playlist?list=${id}`,
		title,
		thumbnail,
		videoCount: badgeText || null,
		channel: parts[0] && !/view|updated|video/i.test(parts[0]) ? { name: parts[0], id: null, url: null, handle: null, verified: false, avatar: null } : null,
		firstVideoId: firstVideo,
	};
}

function parseReelItem(r: J): VideoItem | null {
	const id: string | undefined = r?.videoId ?? r?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? r?.entityId?.replace(/^shorts-shelf-item-/, "");
	if (!id) return null;
	const title = text(r?.headline) || text(r?.overlayMetadata?.primaryText) || text(r?.accessibilityText);
	const views = text(r?.viewCountText) || text(r?.overlayMetadata?.secondaryText) || null;
	const thumb = bestThumb(r?.thumbnail?.thumbnails ?? r?.thumbnail?.sources);
	return {
		type: "short",
		id,
		url: `https://www.youtube.com/shorts/${id}`,
		title,
		thumbnail: thumb ?? `https://i.ytimg.com/vi/${id}/hq2.jpg`,
		duration: null,
		durationSeconds: null,
		views,
		viewCount: null,
		published: null,
		description: null,
		channel: null,
		badges: [],
		live: false,
		upcoming: false,
		isShort: true,
	};
}

export function parseSearchResponse(data: J): ParsedSearch {
	const out: ParsedSearch = { results: [], next: null, estimatedResults: null, correctedQuery: null, blocked: { ads: 0 } };
	const seen = new Set<string>();
	const est = Number.parseInt(data?.estimatedResults ?? "", 10);
	if (Number.isFinite(est)) out.estimatedResults = est;

	const push = (item: Item | null, shelf?: string) => {
		if (!item) return;
		const key = `${item.type === "short" ? "video" : item.type}:${item.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (shelf) item.shelf = shelf;
		out.results.push(item);
	};

	const walk = (node: J, shelf: string | undefined, depth: number): void => {
		if (node == null || typeof node !== "object" || depth > 40) return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child, shelf, depth + 1);
			return;
		}
		for (const [key, value] of Object.entries(node)) {
			if (AD_RENDERERS.has(key)) {
				out.blocked.ads++;
				continue;
			}
			if (SKIP_KEYS.has(key)) continue;
			switch (key) {
				case "videoRenderer":
					push(parseVideoRenderer(value), shelf);
					break;
				case "channelRenderer":
					push(parseChannelRenderer(value), shelf);
					break;
				case "playlistRenderer":
					push(parsePlaylistRenderer(value, "playlist"), shelf);
					break;
				case "radioRenderer":
					push(parsePlaylistRenderer(value, "mix"), shelf);
					break;
				case "lockupViewModel":
					push(parseLockup(value), shelf);
					break;
				case "reelItemRenderer":
				case "shortsLockupViewModel":
					push(parseReelItem(value), shelf ?? "Shorts");
					break;
				case "reelShelfRenderer":
				case "gridShelfViewModel":
					walk(value, text((value as J)?.title) || "Shorts", depth + 1);
					break;
				case "shelfRenderer":
				case "horizontalCardListRenderer":
					walk(value, text((value as J)?.title) || text((value as J)?.header?.richListHeaderRenderer?.title) || "Shelf", depth + 1);
					break;
				case "continuationItemRenderer": {
					const token = (value as J)?.continuationEndpoint?.continuationCommand?.token;
					if (token) out.next = token;
					break;
				}
				case "showingResultsForRenderer":
				case "didYouMeanRenderer":
					out.correctedQuery = text((value as J)?.correctedQuery) || out.correctedQuery;
					break;
				default:
					if (value && typeof value === "object") walk(value, shelf, depth + 1);
			}
		}
	};

	walk(data, undefined, 0);
	return out;
}

/** Pull `ytInitialData` out of a youtube.com/results HTML page (fallback path). */
export function extractInitialData(html: string): J | null {
	const m = /(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.+?\});\s*<\/script>/s.exec(html);
	if (!m) return null;
	try {
		return JSON.parse(m[1]);
	} catch {
		return null;
	}
}
