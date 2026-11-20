// Backups: everything this browser keeps (settings, library, community plugins) as one JSON file,
// so local-only storage isn't a dead end. Importing checks every part again: a backup file is as
// untrusted as anything else a user might be handed.
//
// Not included: watch-party host keys (they grant host control of a room).

import { minVideo, safeUrl } from "./lib.js";
import { validateManifest } from "./plugins.js";

export const BACKUP_FORMAT = "betteryts-backup";
const MAX_BYTES = 5_000_000;

const vids = (list, max) => (Array.isArray(list) ? list : []).map(minVideo).filter(Boolean).slice(0, max);

/** The backup object for the current state. */
export function buildBackup({ settings, library, plugins, version }) {
	return {
		format: BACKUP_FORMAT,
		version: 1,
		site: version,
		exportedAt: new Date().toISOString(),
		settings,
		library,
		plugins: plugins.map(({ enabled, ...manifest }) => ({ ...manifest, enabled })),
	};
}

/** Only keys the site knows, with the same type as their defaults. */
export function cleanSettings(raw, defaults) {
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [k, def] of Object.entries(defaults)) {
		const v = raw[k];
		if (v === undefined) continue;
		if (typeof def === "boolean" && typeof v === "boolean") out[k] = v;
		else if (typeof def === "string" && typeof v === "string") out[k] = v.slice(0, 4000);
		else if (typeof def === "number" && Number.isFinite(v)) out[k] = v;
		else if (def && typeof def === "object" && v && typeof v === "object" && !Array.isArray(v)) {
			// Flag maps (SponsorBlock categories, plugin categories): booleans only, known-looking keys.
			out[k] = Object.fromEntries(Object.entries(v).filter(([kk, vv]) => /^[A-Za-z_]{1,40}$/.test(kk) && typeof vv === "boolean"));
		}
	}
	return out;
}

export function cleanLibrary(raw) {
	const lib = raw && typeof raw === "object" ? raw : {};
	const history = (Array.isArray(lib.history) ? lib.history : [])
		.map((v) => {
			const m = minVideo(v);
			return m ? { ...m, at: Number.isFinite(v.at) ? v.at : Date.now() } : null;
		})
		.filter(Boolean)
		.slice(0, 300);
	const playlists = (Array.isArray(lib.playlists) ? lib.playlists : [])
		.filter((p) => p && typeof p === "object")
		.map((p) => ({
			id: typeof p.id === "string" && /^[a-z0-9]{1,16}$/.test(p.id) ? p.id : Math.random().toString(36).slice(2, 10),
			name: String(p.name || "My playlist").slice(0, 80),
			items: vids(p.items, 500),
			createdAt: Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
		}))
		.slice(0, 100);
	const subscriptions = (Array.isArray(lib.subscriptions) ? lib.subscriptions : [])
		.filter((c) => c && typeof c.id === "string" && /^UC[\w-]{22}$/.test(c.id))
		.map((c) => ({ id: c.id, title: String(c.title || c.id).slice(0, 100), handle: typeof c.handle === "string" ? c.handle.slice(0, 100) : null, avatar: safeUrl(c.avatar), at: Number.isFinite(c.at) ? c.at : Date.now() }))
		.slice(0, 200);
	return { favorites: vids(lib.favorites, 1000), history, playlists, queue: vids(lib.queue, 300), subscriptions };
}

export function cleanPlugins(raw) {
	return (Array.isArray(raw) ? raw : []).flatMap((p) => {
		try {
			return [{ ...validateManifest(p), enabled: p?.enabled !== false }];
		} catch {
			return [];
		}
	}).slice(0, 10);
}

/** Parses and checks a backup file. Throws with a reason people can read. */
export function readBackup(text, defaults) {
	if (typeof text !== "string" || text.length > MAX_BYTES) throw new Error("That file is too big to be a BetterYTS backup");
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("That isn't a BetterYTS backup (expected JSON)");
	}
	if (!raw || raw.format !== BACKUP_FORMAT) throw new Error("That isn't a BetterYTS backup");
	if (raw.version !== 1) throw new Error(`This backup is from a newer version (format ${raw.version}); update the page and try again`);
	const library = cleanLibrary(raw.library);
	return {
		settings: cleanSettings(raw.settings, defaults),
		library,
		plugins: cleanPlugins(raw.plugins),
		exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt.slice(0, 40) : null,
		counts: {
			favorites: library.favorites.length,
			history: library.history.length,
			playlists: library.playlists.length,
			subscriptions: library.subscriptions.length,
			queue: library.queue.length,
		},
	};
}

