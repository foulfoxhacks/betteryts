// Library: queue, favorites, watch history, saved playlists and channel subscriptions. Stored in this browser only.

const KEY = "betteryts.library.v1";
const MAX_HISTORY = 300;
const MAX_QUEUE = 300;
const MAX_PLAYLISTS = 100;
const MAX_PLAYLIST_ITEMS = 500;
const MAX_SUBSCRIPTIONS = 200;

const empty = () => ({ favorites: [], history: [], playlists: [], queue: [], subscriptions: [], disliked: [] });

function load() {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) || "null");
		if (!raw || typeof raw !== "object") return empty();
		return {
			favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
			history: Array.isArray(raw.history) ? raw.history : [],
			playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
			queue: Array.isArray(raw.queue) ? raw.queue : [],
			subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions.filter((c) => c && typeof c.id === "string") : [],
			disliked: Array.isArray(raw.disliked) ? raw.disliked.filter((v) => v && typeof v.id === "string") : [],
		};
	} catch {
		return empty();
	}
}

let data = load();
const listeners = new Set();

function save() {
	try {
		localStorage.setItem(KEY, JSON.stringify(data));
	} catch {
		/* storage full or blocked: keep working in memory */
	}
	for (const fn of listeners) fn(data);
}

// Other tabs
addEventListener("storage", (e) => {
	if (e.key !== KEY) return;
	data = load();
	for (const fn of listeners) fn(data);
});

const uid = () => Math.random().toString(36).slice(2, 10);

export const store = {
	get: () => data,
	/**
	 * Merges an account import (YouTube via Google, Spotify): adds favorites and subscriptions,
	 * and adds or replaces playlists by their `source` (e.g. "youtube:PL…"). Never deletes.
	 * Items must already be checked (minVideo). Returns counts.
	 */
	mergeImport({ favorites = [], playlists = [], subscriptions = [] }) {
		const sum = { favorites: 0, playlists: 0, updated: 0, subscriptions: 0 };
		for (const v of favorites) {
			if (!data.favorites.some((f) => f.id === v.id)) {
				data.favorites.push(v);
				sum.favorites++;
			}
		}
		for (const p of playlists) {
			const items = p.items.slice(0, MAX_PLAYLIST_ITEMS);
			const old = p.source && data.playlists.find((x) => x.source === p.source);
			if (old) {
				old.name = String(p.name).slice(0, 80);
				old.items = items;
				sum.updated++;
			} else if (data.playlists.length < MAX_PLAYLISTS) {
				data.playlists.push({ id: uid(), name: String(p.name || "Playlist").slice(0, 80), items, createdAt: Date.now(), source: p.source || null });
				sum.playlists++;
			}
		}
		for (const c of subscriptions) {
			if (data.subscriptions.length >= MAX_SUBSCRIPTIONS) break;
			if (!data.subscriptions.some((s) => s.id === c.id)) {
				data.subscriptions.push({ ...c, at: Date.now() });
				sum.subscriptions++;
			}
		}
		save();
		return sum;
	},
	/** Replaces the whole library (a checked backup: web/backup.js). */
	replaceAll(lib) {
		data = { ...empty(), ...lib };
		save();
	},
	onChange(fn) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	},

	// Favorites
	isFavorite: (id) => data.favorites.some((v) => v.id === id),
	toggleFavorite(video) {
		if (!video) return false;
		const on = !store.isFavorite(video.id);
		data.favorites = on ? [video, ...data.favorites] : data.favorites.filter((v) => v.id !== video.id);
		save();
		return on;
	},

	// Dislikes (shared with BetterYTS Music: never recommended there, hidden from smart playlists here)
	isDisliked: (id) => (data.disliked ?? []).some((v) => v.id === id),
	toggleDislike(video) {
		if (!video) return false;
		const on = !store.isDisliked(video.id);
		data.disliked = on ? [video, ...(data.disliked ?? [])].slice(0, 5000) : data.disliked.filter((v) => v.id !== video.id);
		if (on) data.favorites = data.favorites.filter((v) => v.id !== video.id);
		save();
		return on;
	},

	// History
	addHistory(video) {
		if (!video) return;
		data.history = [{ ...video, at: Date.now() }, ...data.history.filter((v) => v.id !== video.id)].slice(0, MAX_HISTORY);
		save();
	},
	removeHistory(id) {
		data.history = data.history.filter((v) => v.id !== id);
		save();
	},
	clearHistory() {
		data.history = [];
		save();
	},

	// Queue
	enqueue(videos, { front = false } = {}) {
		const list = (Array.isArray(videos) ? videos : [videos]).filter(Boolean);
		data.queue = (front ? [...list, ...data.queue] : [...data.queue, ...list]).slice(0, MAX_QUEUE);
		save();
		return list.length;
	},
	dequeue() {
		const [next, ...rest] = data.queue;
		data.queue = rest;
		save();
		return next || null;
	},
	removeFromQueue(index) {
		data.queue = data.queue.filter((_, i) => i !== index);
		save();
	},
	moveInQueue(index, delta) {
		const to = index + delta;
		if (to < 0 || to >= data.queue.length) return;
		const q = [...data.queue];
		[q[index], q[to]] = [q[to], q[index]];
		data.queue = q;
		save();
	},
	clearQueue() {
		data.queue = [];
		save();
	},

	// Subscriptions (channel IDs, "UC…", plus enough to draw them without a request)
	isSubscribed: (id) => !!id && data.subscriptions.some((c) => c.id === id),
	toggleSubscription(ch) {
		if (!ch?.id) return false;
		if (store.isSubscribed(ch.id)) {
			data.subscriptions = data.subscriptions.filter((c) => c.id !== ch.id);
			save();
			return false;
		}
		if (data.subscriptions.length >= MAX_SUBSCRIPTIONS) return false;
		const entry = { id: ch.id, title: String(ch.title || ch.handle || ch.id).slice(0, 100), handle: ch.handle || null, avatar: ch.avatar || null, at: Date.now() };
		data.subscriptions = [entry, ...data.subscriptions];
		save();
		return true;
	},
	unsubscribe(id) {
		data.subscriptions = data.subscriptions.filter((c) => c.id !== id);
		save();
	},
	subscriptionLimit: MAX_SUBSCRIPTIONS,

	// Playlists
	playlist: (id) => data.playlists.find((p) => p.id === id) || null,
	createPlaylist(name, items = []) {
		if (data.playlists.length >= MAX_PLAYLISTS) return null;
		const p = { id: uid(), name: String(name || "My playlist").slice(0, 80), items: items.filter(Boolean).slice(0, MAX_PLAYLIST_ITEMS), createdAt: Date.now() };
		data.playlists = [p, ...data.playlists];
		save();
		return p;
	},
	addToPlaylist(id, video) {
		const p = store.playlist(id);
		if (!p || !video || p.items.some((v) => v.id === video.id) || p.items.length >= MAX_PLAYLIST_ITEMS) return false;
		p.items = [...p.items, video];
		save();
		return true;
	},
	removeFromPlaylist(id, index) {
		const p = store.playlist(id);
		if (!p) return;
		p.items = p.items.filter((_, i) => i !== index);
		save();
	},
	renamePlaylist(id, name) {
		const p = store.playlist(id);
		if (!p) return;
		p.name = String(name || p.name).slice(0, 80);
		save();
	},
	deletePlaylist(id) {
		data.playlists = data.playlists.filter((p) => p.id !== id);
		save();
	},
};
