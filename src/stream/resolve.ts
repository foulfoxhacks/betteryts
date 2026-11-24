// BetterYTS Stream: turn audience input (a link, an ID or "artist - song") into a canonical MediaItem
// with BetterYTS's own search and metadata, so every source and destination agrees on what was asked for.
// PearConnect previously searched through the local Pear Desktop player; that path still exists on the
// desktop side as a fallback (docs/stream/parity-matrix.md).

import { search, UpstreamError, videoDetails } from "../lib/innertube.ts";
import { videoIdFromQuery } from "../lib/query.ts";
import type { ClientOptions, VideoItem } from "../lib/types.ts";
import type { MediaItem } from "./contracts.ts";

export type Resolution =
	| { status: "resolved"; media: MediaItem }
	| { status: "no_results"; message: string }
	| { status: "unavailable"; message: string }
	| { status: "unsupported"; message: string };

export interface ResolverDeps {
	search: typeof search;
	videoDetails: typeof videoDetails;
}

const defaultDeps: ResolverDeps = { search, videoDetails };

function fromItem(v: VideoItem): MediaItem {
	return {
		provider: "youtube",
		id: v.id,
		title: v.title.slice(0, 300),
		creator: (v.channel?.name ?? "").slice(0, 200),
		durationSeconds: v.durationSeconds,
		thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
		live: v.live,
	};
}

const LINKISH = /^(https?:\/\/|www\.|youtu\.be\/|(m\.|music\.)?youtube\.com\/)/i;

export async function resolveMedia(input: string, opts: ClientOptions, deps: ResolverDeps = defaultDeps): Promise<Resolution> {
	const id = videoIdFromQuery(input);
	if (id) {
		try {
			const d = await deps.videoDetails(id, opts);
			if (d.playable && d.playable !== "OK") return { status: "unavailable", message: "That video can't be played." };
			return {
				status: "resolved",
				media: { provider: "youtube", id, title: (d.title ?? id).slice(0, 300), creator: (d.author ?? "").slice(0, 200), durationSeconds: d.lengthSeconds, thumbnail: d.thumbnail, live: d.isLive },
			};
		} catch (err) {
			if (err instanceof UpstreamError && err.status === 404) return { status: "unavailable", message: "That video wasn't found." };
			throw err;
		}
	}
	// A link we can't turn into a single video (playlist, channel, another site) is not searched as text.
	if (LINKISH.test(input.trim())) return { status: "unsupported", message: "Only single YouTube videos or a song name can be requested." };
	const found = await deps.search(input, { type: "video" }, opts);
	const first = found.results.find((r): r is VideoItem => (r.type === "video" || r.type === "short") && !r.upcoming);
	return first ? { status: "resolved", media: fromItem(first) } : { status: "no_results", message: `No results for "${input.slice(0, 40)}".` };
}
