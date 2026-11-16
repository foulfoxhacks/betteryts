// Pulls the search term out of every URL shape people (and VRChat players) throw at us:
//   /search?q=lofi        /search?=lofi        /search?lofi+hip+hop
//   /search/lofi hip hop  /lofi%20hip%20hop    /results?search_query=lofi

/** Query-string keys that are options, never the search term. */
export const OPTION_KEYS = new Set([
	"n", "type", "sort", "duration", "upload", "features", "shorts", "shelves", "live",
	"page", "hl", "gl", "to", "lucky", "go", "format", "dearrow", "minlen", "maxlen",
]);

const QUERY_KEYS = ["q", "query", "search", "search_query", "s", ""];

export const MAX_QUERY_LENGTH = 200;

function decode(raw: string): string {
	const plusless = raw.replace(/\+/g, " ");
	try {
		return decodeURIComponent(plusless);
	} catch {
		// A stray "%" breaks decodeURIComponent; decode the valid escape runs one by one instead.
		return plusless.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
			try {
				return decodeURIComponent(run);
			} catch {
				return run;
			}
		});
	}
}

export function cleanQuery(q: string): string {
	return q.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/** Search term from the query string, or "" when there isn't one. */
export function queryFromSearchParams(url: URL): string {
	const params = url.searchParams;
	for (const key of QUERY_KEYS) {
		const value = params.get(key);
		if (value && value.trim()) return cleanQuery(value);
	}
	// Bare form: "?lofi+hip+hop" or "?lofi+hip+hop&n=2" — a key with no value that isn't an option.
	for (const [key, value] of params) {
		const k = key.toLowerCase();
		// "?q=" (empty) is an empty search, not a search for the letter "q".
		if (value === "" && key.trim() && !OPTION_KEYS.has(k) && !QUERY_KEYS.includes(k)) return cleanQuery(key);
	}
	return "";
}

/** Search term from a path remainder such as "lofi%20hip%20hop" or "lofi+hip+hop". */
export function queryFromPath(rest: string): string {
	return cleanQuery(decode(rest.replace(/^\/+/, "")));
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(id: string | null | undefined): id is string {
	return !!id && ID_RE.test(id);
}

/** If the "query" is really a YouTube link (or "id:XXXXXXXXXXX"), return the video ID. */
export function videoIdFromQuery(q: string): string | null {
	const trimmed = q.trim();
	const prefixed = /^id:([A-Za-z0-9_-]{11})$/i.exec(trimmed);
	if (prefixed) return prefixed[1];
	let url: URL;
	try {
		url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		return null;
	}
	const host = url.hostname.replace(/^(www|m|music)\./, "");
	if (host === "youtu.be") {
		const id = url.pathname.slice(1).split("/")[0];
		return isVideoId(id) ? id : null;
	}
	if (host === "youtube.com" || host === "youtube-nocookie.com") {
		const v = url.searchParams.get("v");
		if (isVideoId(v)) return v;
		const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
		if (m) return m[1];
	}
	return null;
}

export function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
	const raw = url.searchParams.get(key);
	if (raw === null || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function boolParam(url: URL, key: string, fallback: boolean): boolean {
	const raw = url.searchParams.get(key);
	if (raw === null) return fallback;
	if (raw === "") return true; // "&lucky" alone means yes
	return !/^(0|false|no|off)$/i.test(raw);
}
