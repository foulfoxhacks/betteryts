// Spotify → BetterYTS playlist import (browser side). The Worker reads the Spotify page
// (/api/spotify) and matches each song to a YouTube video (/api/match); we run the matches
// 4 at a time so a 100-song playlist takes a few seconds and stays gentle on the API.

import { api, minVideo } from "./lib.js";
import { mapLimit } from "./feed.js";

/**
 * @param {string} link Spotify playlist/album link
 * @param {(done: number, total: number) => void} onProgress
 * @param {AbortSignal} [signal]
 */
export async function importSpotify(link, onProgress, signal) {
	const list = await api("/api/spotify", { url: link.trim() }, signal);
	return matchList(list, onProgress, signal);
}

/**
 * Matches every song of a list ({ name, owner, kind, tracks: [{ title, artists, durationMs }] })
 * to its YouTube video. Used for public links and for signed-in Spotify playlists alike.
 */
export async function matchList(list, onProgress, signal) {
	const total = list.tracks.length;
	let done = 0;
	onProgress(0, total);
	const results = await mapLimit(list.tracks, 4, async (t) => {
		if (signal?.aborted) return null;
		const artist = t.artists[0] || "";
		const m = await api(
			"/api/match",
			{ track: t.title, artist, duration: t.durationMs ? Math.round(t.durationMs / 1000) : "" },
			signal,
		).catch(() => null);
		onProgress(++done, total);
		return { track: t, match: m };
	});
	if (signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
	return summarize(list, results);
}

/** Pure: turn match replies into playlist items + a report. */
export function summarize(list, results) {
	const videos = [];
	const unmatched = [];
	const unsure = [];
	results.forEach((r, i) => {
		const t = list.tracks[i];
		const label = `${t.artists.join(", ") || "Unknown"} – ${t.title}`;
		const m = r?.match;
		if (!m?.match || m.confidence === "none") {
			unmatched.push(label);
			return;
		}
		const v = minVideo({ id: m.match.id, title: m.match.title, channel: m.match.channel || "", thumbnail: m.match.thumbnail, duration: m.match.duration || "" });
		if (!v) {
			unmatched.push(label);
			return;
		}
		videos.push(v);
		if (m.confidence === "low") unsure.push(`${label} → ${m.match.title}`);
	});
	return { name: list.name, owner: list.owner, kind: list.kind, mayBeTruncated: !!list.mayBeTruncated, total: list.tracks.length, videos, unmatched, unsure };
}
