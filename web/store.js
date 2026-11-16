// Library: queue, favorites, watch history and saved playlists. Stored in this browser only.

const KEY = "betteryts.library.v1";
const MAX_HISTORY = 300;
const MAX_QUEUE = 300;
const MAX_PLAYLISTS = 100;
const MAX_PLAYLIST_ITEMS = 500;

const empty = () => ({ favorites: [], history: [], playlists: [], queue: [] });

function load() {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) || "null");
		if (!raw || typeof raw !== "object") return empty();
		return {
			favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
			history: Array.isArray(raw.history) ? raw.history : [],
			playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
			queue: Array.isArray(raw.queue) ? raw.queue : [],
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
