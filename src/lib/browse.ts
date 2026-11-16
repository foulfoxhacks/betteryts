// YouTube playlists and channels via InnerTube `browse`, parsed with the same ad-stripping walker.

import { innertube, UpstreamError } from "./innertube.ts";
import { findKey, parseSearchResponse, text } from "./parse.ts";
import type { ClientOptions, Item } from "./types.ts";

// biome-ignore lint: YouTube JSON is untyped
type J = any;

export const CHANNEL_TABS = {
	videos: "EgZ2aWRlb3PyBgQKAjoA",
	live: "EgdzdHJlYW1z8gYECgJ6AA==",
	shorts: "EgZzaG9ydHPyBgUKA5oBAA==",
	playlists: "EglwbGF5bGlzdHPyBgoKCEIGCgIQaCIA",
} as const;
export type ChannelTab = keyof typeof CHANNEL_TABS;

const PLAYLIST_ID = /^(PL|UU|LL|FL|OL|RD|OLAK5uy_)[A-Za-z0-9_-]{8,}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@[\w.-]{3,30}$/;

export function playlistIdFrom(input: string): string | null {
	const s = input.trim();
	const m = /[?&]list=([A-Za-z0-9_-]+)/.exec(s);
	const id = m ? m[1] : s;
	return PLAYLIST_ID.test(id) ? id : null;
}

/** Normalises "UC…", "@handle", or a channel URL to either a channel ID or an @handle. */
export function channelRefFrom(input: string): string | null {
	const s = decodeURIComponent(input.trim());
	const url = /youtube\.com\/(channel\/(UC[\w-]{22})|(@[\w.-]+))/.exec(s);
	const ref = url ? (url[2] ?? url[3]) : s;
	if (CHANNEL_ID.test(ref) || HANDLE.test(ref)) return ref;
	return null;
}

const sources = (node: J): string | null => {
	const list = findKey(node, "sources") ?? findKey(node, "thumbnails");
	if (!Array.isArray(list) || !list.length) return null;
	const best = list.reduce((a: J, b: J) => ((b?.width ?? 0) > (a?.width ?? 0) ? b : a));
	const u: string | undefined = best?.url;
	return u ? (u.startsWith("//") ? `https:${u}` : u) : null;
};

function headerRows(header: J): string[] {
	const rows: J[] = findKey(header?.metadata, "metadataRows") ?? [];
	return rows.flatMap((r) => (r?.metadataParts ?? []).map((p: J) => text(p?.text))).filter(Boolean);
}

export interface PlaylistPage {
	id: string;
	title: string | null;
	description: string | null;
	owner: string | null;
	videoCount: string | null;
	views: string | null;
	thumbnail: string | null;
	results: Item[];
	next: string | null;
}

export async function playlist(id: string, o: ClientOptions, continuation?: string): Promise<PlaylistPage> {
	const data = await innertube("browse", continuation ? { continuation } : { browseId: `VL${id}` }, o);
	if (!continuation && data?.alerts && !findKey(data, "lockupViewModel") && !findKey(data, "playlistVideoRenderer")) {
		throw new UpstreamError("Playlist not found or private", 404);
	}
	const parsed = parseSearchResponse(data);
	const meta = data?.metadata?.playlistMetadataRenderer;
	const header = findKey(data?.header, "pageHeaderViewModel");
	const rows = headerRows(header);
	return {
		id,
		title: meta?.title ?? (text(findKey(header?.title, "dynamicTextViewModel")?.text) || null),
		description: meta?.description || null,
		owner: rows.find((r) => !/videos?|views?|updated|playlist/i.test(r)) ?? null,
		videoCount: rows.find((r) => /videos?\b/i.test(r)) ?? null,
		views: rows.find((r) => /views?\b/i.test(r)) ?? null,
		thumbnail: sources(header?.heroImage) ?? sources(findKey(data?.header, "contentPreviewImageViewModel")),
		results: parsed.results.filter((r) => r.type === "video" || r.type === "short"),
		next: parsed.next,
	};
}

export interface ChannelPage {
	id: string;
	title: string | null;
	handle: string | null;
	description: string | null;
	avatar: string | null;
	banner: string | null;
	subscribers: string | null;
	videoCount: string | null;
	url: string;
	tab: ChannelTab;
	results: Item[];
	next: string | null;
}

async function resolveChannel(ref: string, o: ClientOptions): Promise<string> {
	if (CHANNEL_ID.test(ref)) return ref;
	const res = await innertube("navigation/resolve_url", { url: `https://www.youtube.com/${ref}` }, o);
	const id = res?.endpoint?.browseEndpoint?.browseId;
	if (!id || !CHANNEL_ID.test(id)) throw new UpstreamError("Channel not found", 404);
	return id;
}

export async function channel(ref: string, tab: ChannelTab, o: ClientOptions, continuation?: string): Promise<ChannelPage> {
	const id = await resolveChannel(ref, o);
	const data = await innertube("browse", continuation ? { continuation } : { browseId: id, params: CHANNEL_TABS[tab] }, o);
	const parsed = parseSearchResponse(data);
	const meta = data?.metadata?.channelMetadataRenderer;
	const header = findKey(data?.header, "pageHeaderViewModel");
	const rows = headerRows(header);
	const handle = rows.find((r) => r.startsWith("@")) ?? (meta?.vanityChannelUrl?.match(/@[\w.-]+/)?.[0] ?? null);
	return {
		id,
		title: meta?.title ?? (text(findKey(header?.title, "dynamicTextViewModel")?.text) || null),
		handle,
		description: meta?.description || null,
		avatar: sources(header?.image) ?? sources(meta?.avatar),
		banner: sources(header?.banner),
		subscribers: rows.find((r) => /subscribers?/i.test(r)) ?? null,
		videoCount: rows.find((r) => /videos?\b/i.test(r)) ?? null,
		url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${id}`,
		tab,
		// Channel pages don't need shelves tagged as filler; keep everything the tab lists.
		results: parsed.results.map((r) => {
			delete r.shelf;
			return r;
		}),
		next: parsed.next,
	};
}
