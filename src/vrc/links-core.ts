// Pure helpers for in-world linking (no Workers runtime imports, so Node tests can load them).
//
// A VRChat world can't open a browser or build URLs at runtime, so linking works like a TV
// sign-in: the world loads a baked URL (/vrc/link/start/{service}), shows the activation code it
// gets back, and polls a pool slot. The player opens yts.foulfoxhacks.dev/inworld/{service}/auth
// on their phone, enters the code, signs in, and picks what to send. The world's next poll gets
// the playlists (each song on a pool slot) plus a library number to keep in PlayerData; later
// visits load /vrc/l/{number} (also baked) to get the library back.
//
// Security: codes are 8 characters from a 32-character alphabet (CSPRNG, 40 bits), expire after
// 10 minutes and are single-use; entering codes is rate limited per IP. Library numbers are one
// of LIBRARY_SLOTS and rotate on every load (the old number stops working once the new one is
// used), and loads are rate limited per IP. A library holds only what the player chose to send.
// No account tokens are stored: the import happens in the player's browser.

export const LINK_SERVICES = ["youtube", "spotify"] as const;
export type LinkService = (typeof LINK_SERVICES)[number];
export const LIBRARY_SLOTS = 10000;
export const CODE_TTL_MS = 10 * 60_000;
export const LIBRARY_TTL_MS = 180 * 86_400_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32: no 0/O, 1/I
const MAX_PLAYLISTS = 20;
const MAX_TRACKS_PER_PLAYLIST = 200;
const MAX_TRACKS = 1000;

export interface LinkTrack {
	id: string;
	title: string;
	channel: string;
}
export interface LinkPlaylist {
	name: string;
	tracks: LinkTrack[];
}
export interface LinkLibrary {
	service: LinkService;
	account: string;
	playlists: LinkPlaylist[];
}

/** A fresh activation code like "K7QX-M2PA". */
export function newCode(): string {
	const out: string[] = [];
	const bytes = new Uint8Array(16);
	while (out.length < 8) {
		crypto.getRandomValues(bytes);
		for (const b of bytes) {
			// Rejection sampling keeps every letter equally likely.
			if (b < 256 - (256 % CODE_ALPHABET.length) && out.length < 8) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
		}
	}
	return `${out.slice(0, 4).join("")}-${out.slice(4).join("")}`;
}

/** Accepts what people type ("k7qx m2pa", "K7QXM2PA") and returns the canonical code or null. */
export function normalizeCode(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (c.length !== 8 || [...c].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
	return `${c.slice(0, 4)}-${c.slice(4)}`;
}

const clip = (s: unknown, n: number) =>
	String(s ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, n);

/** Checks a library sent from the site. Throws with a reason. */
export function cleanLibrary(raw: unknown, service: LinkService): LinkLibrary {
	const r = raw as { account?: unknown; playlists?: unknown };
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
	return { service, account: clip(r.account, 60), playlists };
}

/** The world's view of a library: songs with pool slots instead of IDs (Udon can't build URLs). */
export function renderLibrary(lib: LinkLibrary, slots: number[], save: number | null) {
	let i = 0;
	return {
		v: 1,
		status: "linked",
		service: lib.service,
		account: lib.account,
		playlists: lib.playlists.map((p) => ({ name: p.name, tracks: p.tracks.map((t) => ({ title: t.title, channel: t.channel, slot: slots[i++] })) })),
		// Keep this in PlayerData and load /vrc/l/{library} next visit. It changes on every load.
		library: save,
	};
}

export const libraryTrackIds = (lib: LinkLibrary) => lib.playlists.flatMap((p) => p.tracks.map((t) => t.id));

