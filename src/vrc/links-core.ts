// Pure helpers for in-world linking (no Workers runtime imports, so Node tests can load them).
// Protocol: docs/vrchat-protocol.md#linking (linking v2).
//
// A VRChat world can't open a browser or build URLs at runtime, so linking works like a TV
// sign-in: the world loads a baked URL (/vrc/link/start/{service}), shows the activation code it
// gets back, and polls a pool slot. The player opens yts.foulfoxhacks.dev/inworld/{service}/auth,
// enters the code, picks playlists and chooses "Just this visit" (default: nothing kept) or
// "Save for next visit" (kept up to 30 days). Saved libraries come back with a two-part key: the
// world loads /vrc/l/{a} then /vrc/k/{b} (both baked, 0…9999), so there are 10^8 keys, failed
// pairs lock the caller out, and the key changes on every load.
//
// TikTok (src/lib/tiktok.ts) signs in on the server instead (its token exchange needs the app
// secret), revokes the token right after reading the public video list, and stores neither.
//
// Privacy by design: no account tokens are stored (imports run in the player's browser); only
// video IDs, titles and channels are kept, never account names (TikTok links keep the display
// name the world shows); libraries expire 30 days after
// saving (YouTube API data isn't kept longer without refreshing); /vrc/forget and the site can
// delete a library; rate-limit records use IP hashes with a salt that changes daily, kept 24 h.

export const LINK_VERSION = 2;
export const LINK_SERVICES = ["youtube", "spotify", "tiktok"] as const;
export type LinkService = (typeof LINK_SERVICES)[number];
export const KEY_SPACE = 10000; // each half of a library key: /vrc/l/{0…9999} and /vrc/k/{0…9999}
export const CODE_TTL_MS = 10 * 60_000;
export const LIBRARY_TTL_MS = 30 * 86_400_000;
export const STEP_WINDOW_MS = 60_000; // /vrc/l/{a} then /vrc/k/{b} must come within this
export const MAX_FAILED_PAIRS = 5; // per hour per caller, then locked for the hour
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32: no 0/O, 1/I
const MAX_PLAYLISTS = 20;
const MAX_TRACKS_PER_PLAYLIST = 200;
const MAX_TRACKS = 1000;

export interface LinkTrack {
	id: string; // YouTube video ID, or a TikTok video ID (tiktok libraries)
	title: string;
	channel: string;
	// TikTok only: TikTok gives no playable file, so the world gets the official embed link to show.
	embed?: string;
	cover?: string | null;
	duration?: number;
}
export interface LinkPlaylist {
	name: string;
	tracks: LinkTrack[];
}
/** What's kept: playlists of public video IDs, titles and channels. No account details. */
export interface LinkLibrary {
	service: LinkService;
	/** TikTok only: the display name the player signed in as (shown in the world). */
	account?: string;
	playlists: LinkPlaylist[];
}
export interface LibraryKey {
	a: number;
	b: number;
}

/**
 * The network a caller counts as for rate limits and lockouts: the IPv4 address, or an IPv6
 * address's /64 (one home or phone usually gets a whole /64, so per-address limits on IPv6 could
 * be dodged by rotating addresses).
 */
export function clientNet(ip: string): string {
	ip = ip.trim().toLowerCase();
	if (!ip.includes(":")) return ip;
	const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
	if (v4) return v4[1];
	const [head, tail = ""] = ip.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
	return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** A fresh activation code like "K7QX-M2PA" (40 bits from the CSPRNG). */
export function newCode(): string {
	const out: string[] = [];
	const bytes = new Uint8Array(16);
	while (out.length < 8) {
		crypto.getRandomValues(bytes);
		for (const b of bytes) if (out.length < 8) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]); // 256 % 32 == 0: unbiased
	}
	return `${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

/** A random key half, 0…KEY_SPACE-1, unbiased. */
export function keyPart(): number {
	const buf = new Uint32Array(1);
	const limit = Math.floor(0x100000000 / KEY_SPACE) * KEY_SPACE;
	do crypto.getRandomValues(buf);
	while (buf[0] >= limit);
	return buf[0] % KEY_SPACE;
}

/** Accepts what people type ("k7qx m2pa", "K7QXM2PA") and returns the canonical code or null. */
export function normalizeCode(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (c.length !== 8 || [...c].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
	return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** "1234-5678" or { a, b } → a key, or null. */
export function parseKey(input: unknown): LibraryKey | null {
	const k = input as { a?: unknown; b?: unknown } | string | null;
	let a: number;
	let b: number;
	if (typeof k === "string") {
		const m = /^\s*(\d{1,4})\s*[-\s]\s*(\d{1,4})\s*$/.exec(k);
		if (!m) return null;
		a = Number(m[1]);
		b = Number(m[2]);
	} else if (k && typeof k === "object") {
		a = Number(k.a);
		b = Number(k.b);
	} else return null;
	return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < KEY_SPACE && b < KEY_SPACE ? { a, b } : null;
}

export const formatKey = (k: LibraryKey) => `${String(k.a).padStart(4, "0")}-${String(k.b).padStart(4, "0")}`;

const clip = (s: unknown, n: number) =>
	String(s ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, n);

/** Checks a library sent from the site. Throws with a reason. Anything else sent is dropped. */
export function cleanLibrary(raw: unknown, service: LinkService): LinkLibrary {
	// TikTok libraries are only made by the server's own sign-in (/tt/callback), never posted by a client.
	if (service === "tiktok") throw new Error("TikTok links are made by signing in at /inworld/tiktok");
	const r = raw as { playlists?: unknown };
	if (!r || typeof r !== "object" || !Array.isArray(r.playlists)) throw new Error("Expected { playlists: [...] }");
	let total = 0;
	const playlists: LinkPlaylist[] = [];
	for (const p of r.playlists.slice(0, MAX_PLAYLISTS)) {
		const pl = p as { name?: unknown; tracks?: unknown };
		if (!pl || !Array.isArray(pl.tracks)) continue;
		const tracks: LinkTrack[] = [];
		for (const t of pl.tracks) {
			const tt = t as { id?: unknown; title?: unknown; channel?: unknown };
			if (typeof tt?.id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(tt.id)) continue;
			if (tracks.length >= MAX_TRACKS_PER_PLAYLIST || total >= MAX_TRACKS) break;
			tracks.push({ id: tt.id, title: clip(tt.title, 120) || tt.id, channel: clip(tt.channel, 80) });
			total++;
		}
		if (tracks.length) playlists.push({ name: clip(pl.name, 60) || "Playlist", tracks });
	}
	if (!playlists.length) throw new Error("Nothing to send: pick at least one playlist with playable songs");
	return { service, playlists };
}

/** The world's view of a library: songs with pool slots instead of IDs (Udon can't build URLs). */
export function renderLibrary(lib: LinkLibrary, slots: number[], key: LibraryKey | null, expiresAt: number | null) {
	let i = 0;
	if (lib.service === "tiktok") {
		// No pool slots: TikTok videos can't be played through the pool. List them with TikTok's embed link.
		return {
			v: LINK_VERSION,
			ok: true,
			status: "linked",
			service: lib.service,
			account: lib.account ?? "",
			playlists: lib.playlists.map((p) => ({
				name: p.name,
				tracks: p.tracks.map((t) => ({ title: t.title, channel: t.channel, slot: null, id: t.id, embed_link: t.embed ?? "", cover_image_url: t.cover ?? null, duration: t.duration ?? 0 })),
			})),
			library: key ? { a: key.a, b: key.b } : null,
			expiresAt,
		};
	}
	return {
		v: LINK_VERSION,
		ok: true,
		status: "linked",
		service: lib.service,
		playlists: lib.playlists.map((p) => ({ name: p.name, tracks: p.tracks.map((t) => ({ title: t.title, channel: t.channel, slot: slots[i++] as number | null })) })),
		// Saved for next visit: keep these in PlayerData; they change on every load. Null = this visit only.
		library: key ? { a: key.a, b: key.b } : null,
		expiresAt,
	};
}

/** YouTube video IDs to put in pool slots (none for TikTok: those aren't YouTube videos). */
export const libraryTrackIds = (lib: LinkLibrary) => (lib.service === "tiktok" ? [] : lib.playlists.flatMap((p) => p.tracks.map((t) => t.id)));
