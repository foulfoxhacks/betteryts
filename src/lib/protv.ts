// ProTV playlist file (tokenized format, https://protv.dev/guides/playlist):
//   Header text
//   @main url          ← starts an entry
//   ~Title
//   description lines (anything not starting with a prefix symbol)

import type { VideoItem } from "./types.ts";

const PREFIXES = /^[@^/#~?]/;

/** Collapse to one line (a newline would start a new ProTV token). */
function flat(s: string): string {
	return s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A free-text line that must not start with a prefix symbol, or ProTV would misread it. */
function line(s: string): string {
	const f = flat(s);
	return PREFIXES.test(f) ? `​${f}` : f;
}

export function toProTVPlaylist(header: string, videos: VideoItem[]): string {
	const out: string[] = [line(header) || "BetterYTS playlist", ""];
	for (const v of videos) {
		out.push(`@https://www.youtube.com/watch?v=${v.id}`);
		out.push(`~${flat(v.title) || v.id}`);
		const meta = [v.channel?.name, v.live ? "LIVE" : v.duration, v.views].filter(Boolean).join(" · ");
		if (meta) out.push(line(meta));
		out.push("");
	}
	return `${out.join("\n").trimEnd()}\n`;
}
