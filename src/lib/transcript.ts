// Transcripts: a video's captions as timed lines, for the searchable transcript panel.
//
// The web client's transcript panel now needs an attestation token, but the Android app client
// still lists caption tracks whose timedtext URLs serve JSON (fmt=json3) without one.

import { UpstreamError } from "./innertube.ts";
import type { ClientOptions } from "./types.ts";

const ANDROID = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34 };
const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";

export interface TranscriptLine {
	/** Seconds. */
	start: number;
	dur: number;
	text: string;
}

export interface TranscriptLanguage {
	code: string;
	name: string;
	/** Auto-generated (speech recognition). */
	auto: boolean;
}

export interface Transcript {
	id: string;
	language: TranscriptLanguage | null;
	languages: TranscriptLanguage[];
	lines: TranscriptLine[];
}

interface Track {
	baseUrl: string;
	languageCode: string;
	name?: { simpleText?: string; runs?: { text: string }[] };
	kind?: string;
}

const trackName = (t: Track) => t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join("") ?? t.languageCode;

/** Picks the requested language, else a human-made track in the UI language, else English, else the first. */
export function pickTrack<T extends { languageCode: string; kind?: string }>(tracks: T[], want: string | null, hl: string): T | null {
	const base = (c: string) => c.toLowerCase().split("-")[0];
	const human = (t: T) => t.kind !== "asr";
	// "en:asr" asks for the auto-generated track specifically.
	if (want?.endsWith(":asr")) {
		const code = want.slice(0, -4).toLowerCase();
		const auto = tracks.find((t) => t.kind === "asr" && t.languageCode.toLowerCase() === code);
		if (auto) return auto;
		want = code;
	}
	if (want) {
		const exact = tracks.find((t) => t.languageCode.toLowerCase() === want.toLowerCase());
		if (exact) return exact;
		const same = tracks.filter((t) => base(t.languageCode) === base(want));
		if (same.length) return same.find(human) ?? same[0];
	}
	return (
		tracks.find((t) => human(t) && base(t.languageCode) === base(hl)) ??
		tracks.find((t) => human(t) && base(t.languageCode) === "en") ??
		tracks.find(human) ??
		tracks[0] ??
		null
	);
}

/** json3 timedtext → lines. Empty and newline-only events (layout markers) are dropped. */
export function parseJson3(data: unknown): TranscriptLine[] {
	const events = (data as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] })?.events;
	if (!Array.isArray(events)) return [];
	const lines: TranscriptLine[] = [];
	for (const e of events) {
		if (!Array.isArray(e.segs)) continue;
		const text = e.segs
			.map((s) => s.utf8 ?? "")
			.join("")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		lines.push({ start: Math.round((e.tStartMs ?? 0) / 10) / 100, dur: Math.round((e.dDurationMs ?? 0) / 10) / 100, text: text.slice(0, 500) });
	}
	return lines;
}

/** Only YouTube's own caption host may be fetched (the URL comes from YouTube's response). */
function safeCaptionUrl(raw: string): URL | null {
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(u.hostname) || !u.pathname.startsWith("/api/timedtext")) return null;
		u.searchParams.set("fmt", "json3");
		return u;
	} catch {
		return null;
	}
}

export async function transcript(id: string, want: string | null, o: ClientOptions): Promise<Transcript> {
	const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
		body: JSON.stringify({ context: { client: { ...ANDROID, hl: o.hl, gl: o.gl } }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
	});
	if (!res.ok) throw new UpstreamError(`YouTube player returned HTTP ${res.status}`);
	const p = (await res.json()) as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } }; playabilityStatus?: { status?: string } };
	const tracks = p.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
	const languages = tracks.map((t) => ({ code: t.languageCode, name: trackName(t), auto: t.kind === "asr" }));
	const track = pickTrack(tracks, want, o.hl);
	if (!track) return { id, language: null, languages, lines: [] };
	const url = safeCaptionUrl(track.baseUrl);
	if (!url) throw new UpstreamError("Unexpected caption URL from YouTube");
	const cap = await fetch(url, { headers: { "User-Agent": ANDROID_UA } });
	if (!cap.ok) throw new UpstreamError(`YouTube captions returned HTTP ${cap.status}`);
	const text = await cap.text();
	let lines: TranscriptLine[] = [];
	try {
		lines = parseJson3(JSON.parse(text));
	} catch {
		lines = [];
	}
	return { id, language: { code: track.languageCode, name: trackName(track), auto: track.kind === "asr" }, languages, lines };
}
