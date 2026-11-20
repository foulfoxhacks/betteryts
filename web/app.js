// BetterYTS by FoulFoxHacks — front page. Plain ES modules, no framework.
// Everything from the API is inserted with textContent / attributes — never innerHTML.

import { bestChapters, toSeconds } from "./chapters.js";
import { currentTheme, initChrome, setTheme, THEMES } from "./chrome.js";
import { $, $$, api, copy, fmtCount, fmtTime, h, isVideoId, minVideo, safeUrl, toast } from "./lib.js";
import { mapLimit, mergeFeed } from "./feed.js";
import { hostKeys, RoomClient } from "./room.js";
import { importSpotify } from "./spotify.js";
import { store } from "./store.js";

initChrome();

// ---------------------------------------------------------------------------------------------
// Settings (per-browser convenience only)
// ---------------------------------------------------------------------------------------------

const SB = {
	sponsor: { label: "Sponsor", color: "#00d400", skip: true },
	selfpromo: { label: "Self-promotion", color: "#ffff00", skip: true },
	exclusive_access: { label: "Exclusive access", color: "#008a5c", skip: false },
	interaction: { label: "Interaction reminder", color: "#cc00ff", skip: true },
	intro: { label: "Intro", color: "#00ffff", skip: false },
	outro: { label: "Endcards / credits", color: "#0202ed", skip: false },
	preview: { label: "Preview / recap", color: "#008fd6", skip: false },
	hook: { label: "Hook / greetings", color: "#395699", skip: false },
	filler: { label: "Filler tangent", color: "#7300ff", skip: false },
	music_offtopic: { label: "Non-music section", color: "#ff9900", skip: false },
	poi_highlight: { label: "Highlight", color: "#ff1684", skip: false },
};

const DEFAULTS = {
	// Plugins
	sponsorblock: true,
	lyrics: true,
	sleep: true,
	vrchat: true,
	hideShorts: true,
	dearrow: true,
	dislikes: true,
	autoplay: true,
	captions: false,
	autoNext: true,
	partyName: "",
	region: "",
	skip: Object.fromEntries(Object.entries(SB).map(([k, v]) => [k, v.skip])),
};

function loadSettings() {
	try {
		const raw = JSON.parse(localStorage.getItem("betteryts.settings") || "{}");
		return { ...DEFAULTS, ...raw, skip: { ...DEFAULTS.skip, ...(raw.skip || {}) } };
	} catch {
		return structuredClone(DEFAULTS);
	}
}
function saveSettings() {
	try {
		localStorage.setItem("betteryts.settings", JSON.stringify(settings));
	} catch {
		/* private mode etc. — settings just won't persist */
	}
}
const settings = loadSettings();

// ---------------------------------------------------------------------------------------------
// URL helpers & internal navigation
// ---------------------------------------------------------------------------------------------

const params = () => new URLSearchParams(location.search);

/** Current URL with some params changed (null removes). */
function withParams(patch) {
	const p = params();
	for (const [k, v] of Object.entries(patch)) {
		if (v == null || v === "") p.delete(k);
		else p.set(k, v);
	}
	const s = p.toString();
	return s ? `/?${s}` : "/";
}

function navigate(url, { replace = false, watchState = false } = {}) {
	if (replace) history.replaceState(watchState ? { watch: true } : {}, "", url);
	else history.pushState(watchState ? { watch: true } : {}, "", url);
	syncFromUrl();
}

// Internal links (cards, channels, library…) are plain <a href> with data-internal.
document.addEventListener("click", (e) => {
	const a = e.target.closest("a[data-internal]");
	if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	e.preventDefault();
	if (watch.open && !a.closest("#watch")) return;
	if (a.closest("#watch")) closeWatch({ leaveRoom: true });
	navigate(a.getAttribute("href"));
	window.scrollTo({ top: 0 });
});

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

const form = $("#search-form");
const input = $("#q");
const filtersEl = $("#filters");
const resultsEl = $("#results");
const statusEl = $("#status");

const VIEWS = { home: ["#home", "#hero"], results: ["#results-view"], library: ["#library-view"], channel: ["#channel-view"], playlist: ["#playlist-view"] };
let currentView = "";

function showView(name, title) {
	currentView = name;
	for (const [view, sels] of Object.entries(VIEWS)) for (const s of sels) $(s).hidden = view !== name;
	// One search form: big in the hero on the home page, compact in the navbar elsewhere.
	const slot = name === "home" ? $("#hero-search-slot") : $("#nav-search-slot");
	if (form.parentElement !== slot) {
		const hadFocus = document.activeElement === input;
		slot.append(form);
		if (hadFocus) input.focus();
	}
	for (const a of $$("[data-nav]")) a.classList.toggle("active", (a.dataset.nav === "library" && name === "library") || (a.dataset.nav === "search" && (name === "home" || name === "results")));
	document.title = title ? `${title} · BetterYTS by FoulFoxHacks` : "BetterYTS by FoulFoxHacks — Ad-free YouTube Search for the Web & VRChat";
	document.body.classList.toggle("with-guide", name !== "home");
	$("#guide").hidden = name === "home";
	renderGuide();
	if (name === "home") renderHomeShelves();
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

const state = { key: "", q: "", next: null, loading: false, controller: null, count: 0, blocked: { ads: 0, shorts: 0, shelfItems: 0 } };

function readFilters() {
	const f = {};
	for (const sel of $$("select", filtersEl)) if (sel.value && !(sel.name === "type" && sel.value === "all") && !(sel.name === "sort" && sel.value === "relevance")) f[sel.name] = sel.value;
	const feats = $$(".chip[aria-pressed=true]", filtersEl).map((c) => c.dataset.feature);
	if (feats.length) f.features = feats.join(",");
	return f;
}

function writeFilters(p) {
	for (const sel of $$("select", filtersEl)) sel.value = p.get(sel.name) || sel.options[0].value;
	const feats = (p.get("features") || "").split(",");
	for (const chip of $$(".chip", filtersEl)) chip.setAttribute("aria-pressed", String(feats.includes(chip.dataset.feature)));
}

function searchUrl(q, filters) {
	const p = new URLSearchParams();
	if (q) p.set("q", q);
	for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
	const s = p.toString();
	return s ? `/?${s}` : "/";
}

const skeletons = (n) => Array.from({ length: n }, () => h("div", { class: "card skeleton" }, h("div", { class: "thumb" }), h("div", { class: "line" }), h("div", { class: "line short" })));

async function runSearch({ append = false } = {}) {
	if (!state.q) return;
	if (append && (!state.next || state.loading)) return;

	state.controller?.abort();
	const controller = new AbortController();
	state.controller = controller;
	state.loading = true;
	$("#load-more").hidden = true;

	if (!append) {
		state.count = 0;
		state.blocked = { ads: 0, shorts: 0, shelfItems: 0 };
		resultsEl.replaceChildren(...skeletons(8));
		statusEl.textContent = "Searching…";
		$("#corrected").hidden = true;
	}

	const query = { q: state.q, ...readFilters(), shorts: settings.hideShorts ? "0" : "1", gl: settings.region, page: append ? state.next : "" };
	let ok = false;
	try {
		const data = await api("/api/search", query, controller.signal);
		if (controller !== state.controller) return;
		if (!append) resultsEl.replaceChildren();
		resultsEl.append(...data.results.map(renderCard).filter(Boolean));
		state.next = data.next;
		state.count += data.results.length;
		state.blocked.ads += data.blocked.ads;
		state.blocked.shorts += data.blocked.shorts;
		state.blocked.shelfItems += data.blocked.shelfItems;
		if (!append && data.correctedQuery) {
			const c = $("#corrected");
			c.replaceChildren("Showing results for ", h("b", {}, data.correctedQuery));
			c.hidden = false;
		}
		renderStatus(data.estimatedResults);
		if (!state.count) resultsEl.replaceChildren(h("div", { class: "empty" }, h("p", {}, "No results. Try fewer filters or different words.")));
		if (settings.dearrow) applyDeArrow(data.results);
		$("#load-more").hidden = !state.next;
		ok = true;
	} catch (err) {
		if (err.name === "AbortError") return;
		if (!append) resultsEl.replaceChildren(h("div", { class: "empty" }, h("p", {}, `Search failed: ${err.message}`), h("button", { class: "button secondary", type: "button", onclick: () => runSearch() }, "Try again")));
		else toast(`Couldn't load more: ${err.message}`);
	} finally {
		if (controller === state.controller) {
			state.loading = false;
			// Short pages leave the sentinel on screen, which the observer won't re-report.
			if (ok) requestAnimationFrame(() => state.next && !state.loading && currentView === "results" && $("#sentinel").getBoundingClientRect().top < innerHeight + 800 && runSearch({ append: true }));
		}
	}
}

function renderStatus(estimated) {
	const parts = [];
	if (estimated) parts.push(`About ${fmtCount(estimated)} results`);
	const b = state.blocked;
	const junk = [];
	if (b.ads) junk.push(`${b.ads} ad${b.ads === 1 ? "" : "s"}`);
	if (b.shorts) junk.push(`${b.shorts} Short${b.shorts === 1 ? "" : "s"}`);
	if (b.shelfItems) junk.push(`${b.shelfItems} shelf filler${b.shelfItems === 1 ? "" : "s"}`);
	statusEl.replaceChildren(parts.join(" · "), junk.length ? h("span", { class: "blocked" }, `🛡 Blocked ${junk.join(", ")}`) : "");
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

const channelHref = (ch) => {
	const ref = ch?.handle || ch?.id || ch?.channelRef;
	return ref ? `/?channel=${encodeURIComponent(ref)}` : null;
};

function renderCard(item) {
	if (item.type === "video" || item.type === "short") return videoCard(item);
	if (item.type === "channel") return channelCard(item);
	if (item.type === "playlist" || item.type === "mix") return playlistCard(item);
	return null;
}

function videoCard(v) {
	const badge = v.live
		? h("span", { class: "badge live" }, "LIVE")
		: v.upcoming
			? h("span", { class: "badge" }, "UPCOMING")
			: v.isShort
				? h("span", { class: "badge" }, "SHORT")
				: v.duration
					? h("span", { class: "badge" }, v.duration)
					: null;
	const href = withParams({ v: v.id });
	const ch = typeof v.channel === "string" ? { name: v.channel, channelRef: v.channelRef } : v.channel;
	const chInternal = channelHref(ch);
	const favOn = store.isFavorite(v.id);
	const quick = h(
		"div",
		{ class: "card-actions" },
		h("button", { type: "button", class: "quick", title: "Add to queue", "aria-label": "Add to queue", onclick: (e) => (e.preventDefault(), e.stopPropagation(), addToQueue(v)) }, "+"),
		h(
			"button",
			{ type: "button", class: favOn ? "quick on" : "quick", title: "Favorite", "aria-label": "Favorite", "aria-pressed": String(favOn), onclick: (e) => (e.preventDefault(), e.stopPropagation(), toggleFav(v, e.currentTarget)) },
			favOn ? "♥" : "♡",
		),
	);
	const card = h(
		"article",
		{ class: "card video", "data-id": v.id },
		h(
			"a",
			{ class: "thumb", href, onclick: (e) => openFromCard(e, v), "aria-label": v.title },
			h("img", { src: safeUrl(v.thumbnail) || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, alt: `Thumbnail: ${v.title}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }),
			badge,
			quick,
		),
		h(
			"div",
			{ class: "meta" },
			ch?.avatar ? h("img", { class: "avatar", src: safeUrl(ch.avatar), alt: `${ch.name} channel avatar`, loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "avatar ph" }),
			h(
				"div",
				{ class: "meta-text" },
				h("a", { class: "title", href, onclick: (e) => openFromCard(e, v), title: v.title }, v.title),
				ch?.name
					? chInternal
						? h("a", { class: "channel", href: chInternal, "data-internal": true }, ch.name, ch.verified ? h("span", { class: "check", title: "Verified" }, " ✓") : "")
						: h("span", { class: "channel" }, ch.name)
					: null,
				h("span", { class: "sub" }, [v.views, v.published].filter(Boolean).join(" · ")),
			),
		),
	);
	card._item = v;
	return card;
}

function channelCard(c) {
	const href = `/?channel=${encodeURIComponent(c.handle || c.id)}`;
	return h(
		"article",
		{ class: "card channel" },
		h("a", { class: "channel-avatar", href, "data-internal": true }, c.thumbnail ? h("img", { src: safeUrl(c.thumbnail), alt: `${c.title} channel avatar`, loading: "lazy", referrerpolicy: "no-referrer" }) : ""),
		h(
			"div",
			{ class: "meta-text" },
			h("a", { class: "title", href, "data-internal": true }, c.title, c.verified ? h("span", { class: "check" }, " ✓") : ""),
			h("span", { class: "sub" }, [c.handle, c.subscribers].filter(Boolean).join(" · ")),
			c.description ? h("p", { class: "desc-snippet" }, c.description) : null,
			h("span", { class: "kind" }, "Channel"),
		),
	);
}

function playlistCard(p) {
	const isMix = p.type === "mix";
	const href = isMix && p.firstVideoId ? withParams({ v: p.firstVideoId, list: p.id }) : `/?list=${encodeURIComponent(p.id)}`;
	const open = (e) => {
		if (isMix && p.firstVideoId) openFromCard(e, { id: p.firstVideoId, title: p.title, list: p.id });
	};
	const linkProps = isMix ? { href, onclick: open } : { href, "data-internal": true };
	return h(
		"article",
		{ class: "card playlist" },
		h(
			"a",
			{ class: "thumb stack", ...linkProps },
			p.thumbnail ? h("img", { src: safeUrl(p.thumbnail), alt: `Playlist thumbnail: ${p.title}`, loading: "lazy", referrerpolicy: "no-referrer" }) : "",
			h("span", { class: "badge list" }, isMix ? "MIX" : p.videoCount || "PLAYLIST"),
		),
		h(
			"div",
			{ class: "meta" },
			h("div", { class: "meta-text" }, h("a", { class: "title", ...linkProps }, p.title), p.channel ? h("span", { class: "channel" }, p.channel.name) : null, h("span", { class: "kind" }, isMix ? "Mix" : "Playlist")),
		),
	);
}

async function applyDeArrow(items) {
	const ids = items.filter((i) => i.type === "video").map((i) => i.id);
	for (let i = 0; i < ids.length; i += 30) {
		let brands;
		try {
			brands = await api("/api/branding", { ids: ids.slice(i, i + 30).join(",") });
		} catch {
			return;
		}
		for (const [id, b] of Object.entries(brands)) {
			if (!b) continue;
			for (const card of $$(`.card.video[data-id="${CSS.escape(id)}"]`)) {
				const item = card._item;
				if (b.title) {
					const t = $(".title", card);
					t.textContent = b.title;
					t.title = `Original: ${item.title}`;
					t.append(h("span", { class: "da", title: `DeArrow title · original: ${item.title}` }, "DA"));
					item.branding = b;
				}
				if (b.thumbnail) {
					const img = $(".thumb img", card);
					const fallback = img.src;
					img.onerror = () => {
						img.onerror = null;
						img.src = fallback;
					};
					img.src = b.thumbnail;
				}
			}
		}
	}
}

function addToQueue(v) {
	const video = minVideo(v);
	if (!video) return;
	if (room) {
		if (partySend({ t: "queue_add", video: { id: video.id, title: video.title } })) toast("Added to the watch party");
		return;
	}
	store.enqueue(video);
	toast(`Added to queue (${store.get().queue.length})`, { label: "View", run: () => navigate("/?view=library&tab=queue") });
}

function toggleFav(v, button) {
	const on = store.toggleFavorite(minVideo(v));
	if (button) {
		button.textContent = on ? "♥" : "♡";
		button.classList.toggle("on", on);
		button.setAttribute("aria-pressed", String(on));
	}
	toast(on ? "Added to favorites" : "Removed from favorites");
	return on;
}

// ---------------------------------------------------------------------------------------------
// Suggestions & search form
// ---------------------------------------------------------------------------------------------

const sugg = $("#suggestions");
let suggTimer;
let suggIndex = -1;
let suggController;

function closeSuggestions() {
	sugg.hidden = true;
	suggIndex = -1;
	input.setAttribute("aria-expanded", "false");
	input.removeAttribute("aria-activedescendant");
}

input.addEventListener("input", () => {
	clearTimeout(suggTimer);
	const q = input.value.trim();
	if (!q) return closeSuggestions();
	suggTimer = setTimeout(async () => {
		suggController?.abort();
		suggController = new AbortController();
		try {
			const list = await api("/api/suggest", { q, gl: settings.region }, suggController.signal);
			if (input.value.trim() !== q || !list.length) return closeSuggestions();
			sugg.replaceChildren(...list.map((s, i) => h("li", { id: `sugg-${i}`, role: "option", "aria-selected": "false", onmousedown: (e) => (e.preventDefault(), submitQuery(s)) }, s)));
			sugg.hidden = false;
			suggIndex = -1;
			input.setAttribute("aria-expanded", "true");
		} catch {
			/* ignore */
		}
	}, 140);
});

input.addEventListener("keydown", (e) => {
	if (sugg.hidden) return;
	const items = $$("li", sugg);
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		suggIndex = (suggIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length + 1) % (items.length + 1);
		items.forEach((li, i) => li.setAttribute("aria-selected", String(i === suggIndex)));
		if (suggIndex < items.length) {
			input.value = items[suggIndex].textContent;
			input.setAttribute("aria-activedescendant", items[suggIndex].id);
		}
	} else if (e.key === "Escape") closeSuggestions();
});
input.addEventListener("blur", () => setTimeout(closeSuggestions, 100));

function submitQuery(q) {
	input.value = q;
	closeSuggestions();
	const clean = q.trim();
	if (!clean) return;
	navigate(searchUrl(clean, readFilters()));
	input.blur();
}

form.addEventListener("submit", (e) => {
	e.preventDefault();
	submitQuery(input.value);
});
filtersEl.addEventListener("change", () => state.q && submitQuery(state.q));
filtersEl.addEventListener("click", (e) => {
	const chip = e.target.closest(".chip");
	if (!chip) return;
	chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
	if (state.q) submitQuery(state.q);
});

new IntersectionObserver((entries) => {
	if (entries.some((e) => e.isIntersecting) && state.next && !state.loading && currentView === "results") runSearch({ append: true });
}, { rootMargin: "800px" }).observe($("#sentinel"));
$("#load-more").addEventListener("click", () => runSearch({ append: true }));

// ---------------------------------------------------------------------------------------------
// Library (queue, favorites, history, playlists, watch party)
// ---------------------------------------------------------------------------------------------

const libBody = $("#library-body");
let libTab = "queue";

function rowItem(video, actions, extra) {
	return h(
		"li",
		{ class: "row-item" },
		h("a", { class: "row-thumb", href: withParams({ v: video.id }), onclick: (e) => openFromCard(e, video) }, h("img", { src: safeUrl(video.thumbnail) || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }), video.duration ? h("span", { class: "badge" }, video.duration) : null),
		h("div", { class: "row-text" }, h("a", { class: "title", href: withParams({ v: video.id }), onclick: (e) => openFromCard(e, video) }, video.title), h("span", { class: "sub" }, [video.channel, extra].filter(Boolean).join(" · "))),
		h("div", { class: "row-actions" }, actions),
	);
}

const iconBtn = (label, title, onclick) => h("button", { type: "button", class: "button tiny secondary", title, "aria-label": title, onclick }, label);

function playList(videos, { shuffle = false } = {}) {
	const list = videos.filter(Boolean);
	if (!list.length) return;
	if (shuffle) for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[list[i], list[j]] = [list[j], list[i]];
	}
	const [first, ...rest] = list;
	store.clearQueue();
	store.enqueue(rest);
	navigate(withParams({ v: first.id }), { watchState: true });
}

function shareUrl(name, videos) {
	const ids = videos.slice(0, 50).map((v) => v.id).join(",");
	return `${location.origin}/?view=shared&name=${encodeURIComponent(name)}&ids=${ids}`;
}

function protvText(name, videos) {
	const flat = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
	return [flat(name), "", ...videos.flatMap((v) => [`@https://www.youtube.com/watch?v=${v.id}`, `~${flat(v.title)}`, ""])].join("\n");
}

function renderLibrary() {
	for (const t of $$("[data-lib-tab]")) t.setAttribute("aria-selected", String(t.dataset.libTab === libTab));
	const d = store.get();
	const empty = (msg) => h("div", { class: "empty" }, h("p", {}, msg));

	if (libTab === "subs") {
		renderSubscriptions(d.subscriptions);
	} else if (libTab === "queue") {
		libBody.replaceChildren(
			h("div", { class: "lib-actions" }, h("button", { type: "button", class: "button small primary", onclick: () => playList(d.queue), disabled: !d.queue.length }, "▶ Play queue"), h("button", { type: "button", class: "button small secondary", onclick: () => store.clearQueue(), disabled: !d.queue.length }, "Clear")),
			d.queue.length
				? h("ol", { class: "row-list" }, d.queue.map((v, i) => rowItem(v, [iconBtn("▶", "Play now", () => (store.removeFromQueue(i), navigate(withParams({ v: v.id }), { watchState: true }))), iconBtn("↑", "Move up", () => store.moveInQueue(i, -1)), iconBtn("↓", "Move down", () => store.moveInQueue(i, 1)), iconBtn("✕", "Remove", () => store.removeFromQueue(i))])))
				: empty("Your queue is empty. Use + on any video to add it."),
		);
	} else if (libTab === "favorites") {
		libBody.replaceChildren(
			h("div", { class: "lib-actions" }, h("button", { type: "button", class: "button small primary", onclick: () => playList(d.favorites), disabled: !d.favorites.length }, "▶ Play all"), h("button", { type: "button", class: "button small secondary", onclick: () => playList(d.favorites, { shuffle: true }), disabled: !d.favorites.length }, "Shuffle"), h("button", { type: "button", class: "button small secondary", onclick: () => copy(shareUrl("Favorites", d.favorites), "Share link"), disabled: !d.favorites.length }, "Copy share link")),
			d.favorites.length ? h("div", { class: "grid" }, d.favorites.map((v) => videoCard(v))) : empty("No favorites yet. Tap ♡ on a video."),
		);
	} else if (libTab === "history") {
		const ago = (t) => {
			const m = Math.round((Date.now() - t) / 60000);
			return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
		};
		libBody.replaceChildren(
			h("div", { class: "lib-actions" }, h("button", { type: "button", class: "button small secondary", onclick: () => confirm("Clear your watch history in this browser?") && store.clearHistory(), disabled: !d.history.length }, "Clear history")),
			d.history.length ? h("ol", { class: "row-list" }, d.history.map((v) => rowItem(v, [iconBtn("+", "Add to queue", () => addToQueue(v)), iconBtn("✕", "Remove from history", () => store.removeHistory(v.id))], ago(v.at)))) : empty("Nothing watched yet."),
		);
	} else if (libTab === "playlists") {
		const nameInput = h("input", { type: "text", maxlength: 80, placeholder: "New playlist name", "aria-label": "New playlist name" });
		libBody.replaceChildren(
			h("form", { class: "lib-actions", onsubmit: (e) => (e.preventDefault(), nameInput.value.trim() && (store.createPlaylist(nameInput.value.trim()), toast("Playlist created"))) }, nameInput, h("button", { type: "submit", class: "button small primary" }, "Create playlist")),
			spotifyPanel(),
			d.playlists.length
				? h(
						"div",
						{ class: "playlist-list" },
						d.playlists.map((p) =>
							h(
								"details",
								{ class: "playlist-item" },
								h("summary", {}, h("b", {}, p.name), h("span", { class: "muted" }, ` · ${p.items.length} video${p.items.length === 1 ? "" : "s"}`)),
								h(
									"div",
									{ class: "lib-actions" },
									h("button", { type: "button", class: "button tiny primary", onclick: () => playList(p.items), disabled: !p.items.length }, "▶ Play"),
									h("button", { type: "button", class: "button tiny secondary", onclick: () => playList(p.items, { shuffle: true }), disabled: !p.items.length }, "Shuffle"),
									h("button", { type: "button", class: "button tiny secondary", onclick: () => (store.enqueue(p.items), toast("Added to queue")), disabled: !p.items.length }, "+ Queue all"),
									h("button", { type: "button", class: "button tiny secondary", onclick: () => copy(shareUrl(p.name, p.items), "Share link"), disabled: !p.items.length }, "Share link"),
									h("button", { type: "button", class: "button tiny secondary", title: "Paste into a ProTV playlist file", onclick: () => copy(protvText(p.name, p.items), "ProTV playlist"), disabled: !p.items.length }, "Copy for ProTV"),
									h("button", { type: "button", class: "button tiny secondary", onclick: () => { const n = prompt("Rename playlist", p.name); if (n) store.renamePlaylist(p.id, n); } }, "Rename"),
									h("button", { type: "button", class: "button tiny secondary", onclick: () => confirm(`Delete “${p.name}”?`) && store.deletePlaylist(p.id) }, "Delete"),
								),
								p.items.length ? h("ol", { class: "row-list" }, p.items.map((v, i) => rowItem(v, [iconBtn("+", "Add to queue", () => addToQueue(v)), iconBtn("✕", "Remove", () => store.removeFromPlaylist(p.id, i))]))) : h("p", { class: "muted" }, "Empty. Use “Save to playlist” while watching."),
							),
						),
					)
				: empty("No playlists yet."),
		);
	} else if (libTab === "party") {
		const code = h("input", { type: "text", maxlength: 6, placeholder: "ABC123", "aria-label": "Room code", class: "room-code-input", autocapitalize: "characters" });
		libBody.replaceChildren(
			h(
				"div",
				{ class: "party-grid" },
				h("div", { class: "side-panel" }, h("h3", {}, "Start a watch party"), h("p", { class: "muted" }, "Everyone in the room sees the same video at the same time, with a shared queue. VRChat players can follow the room with its VRChat link."), h("button", { type: "button", class: "button primary", onclick: () => startParty(null) }, "Create a room")),
				h(
					"form",
					{ class: "side-panel", onsubmit: (e) => (e.preventDefault(), /^[A-Za-z0-9]{6}$/.test(code.value.trim()) ? navigate(`/?room=${code.value.trim().toUpperCase()}`) : toast("Room codes are 6 letters/numbers")) },
					h("h3", {}, "Join a room"),
					code,
					h("button", { type: "submit", class: "button secondary" }, "Join"),
				),
			),
		);
	}
}

// ---------- Subscriptions: followed channels' latest uploads, merged. No Google account. ----------

const FEED_TTL = 10 * 60 * 1000;
let subsFeed = { key: "", at: 0, items: null, failed: 0 };
let subsLoading = null;
let subsLoadingKey = "";

function renderSubscriptions(subs, { refresh = false } = {}) {
	if (!subs.length) {
		libBody.replaceChildren(
			h("div", { class: "empty" }, h("p", {}, "You're not subscribed to any channels yet."), h("p", { class: "muted" }, "Open a channel and tap Subscribe. Subscriptions stay in this browser: no Google account needed.")),
		);
		return;
	}
	const chips = h(
		"div",
		{ class: "sub-chips" },
		subs.map((c) =>
			h(
				"span",
				{ class: "sub-chip" },
				h("a", { href: `/?channel=${encodeURIComponent(c.id)}`, "data-internal": true }, safeUrl(c.avatar) ? h("img", { src: safeUrl(c.avatar), alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null, c.title),
				h("button", { type: "button", class: "sub-chip-x", title: `Unsubscribe from ${c.title}`, "aria-label": `Unsubscribe from ${c.title}`, onclick: () => store.unsubscribe(c.id) }, "✕"),
			),
		),
	);
	const grid = h("div", { class: "grid" });
	const status = h("p", { class: "muted sub-status" });
	libBody.replaceChildren(
		h(
			"div",
			{ class: "lib-actions" },
			h("button", { type: "button", class: "button small primary", onclick: () => playList((subsFeed.items || []).map(minVideo).filter(Boolean)) }, "▶ Play latest"),
			h("button", { type: "button", class: "button small secondary", onclick: () => renderSubscriptions(store.get().subscriptions, { refresh: true }) }, "Refresh"),
			h("span", { class: "muted" }, `${subs.length} channel${subs.length === 1 ? "" : "s"}`),
		),
		chips,
		status,
		grid,
	);
	const key = subs.map((c) => c.id).sort().join(",");
	const fresh = subsFeed.key === key && subsFeed.items && Date.now() - subsFeed.at < FEED_TTL;
	if (fresh && !refresh) return drawFeed(grid, status);
	grid.replaceChildren(...skeletons(8));
	status.textContent = "Loading the latest uploads…";
	// A re-render while loading (e.g. a ♡ tap) reuses the request already in flight.
	if (refresh || !subsLoading || subsLoadingKey !== key) {
		subsLoadingKey = key;
		subsLoading = loadFeed(subs, key).finally(() => {
			if (subsLoadingKey === key) subsLoadingKey = "";
		});
	}
	const run = subsLoading;
	run.then(() => {
		// Still looking at the same tab and the same set of channels?
		if (run !== subsLoading || libTab !== "subs" || !grid.isConnected) return;
		drawFeed(grid, status);
	});
}

async function loadFeed(subs, key) {
	const pages = await mapLimit(subs, 4, async (c) => {
		const d = await api(`/api/channel/${encodeURIComponent(c.id)}`, { tab: "videos", gl: settings.region });
		return { channel: { name: d.title || c.title, id: c.id, handle: d.handle || c.handle, avatar: d.avatar || c.avatar, url: null, verified: false }, results: d.results || [] };
	});
	subsFeed = { key, at: Date.now(), items: mergeFeed(pages.filter(Boolean), 60), failed: pages.filter((p) => !p).length };
}

function drawFeed(grid, status) {
	const items = subsFeed.items || [];
	grid.replaceChildren(...items.map((v) => videoCard(v)));
	status.textContent = [
		items.length ? "Newest uploads first (YouTube only gives approximate dates)." : "No recent uploads from these channels.",
		subsFeed.failed ? `${subsFeed.failed} channel${subsFeed.failed === 1 ? "" : "s"} couldn't be loaded.` : "",
	]
		.filter(Boolean)
		.join(" ");
	if (settings.dearrow) applyDeArrow(items);
}

function updateSubButton() {
	const btn = $("#ch-sub");
	const ch = chState.channel;
	btn.hidden = !ch?.id;
	if (!ch?.id) return;
	const on = store.isSubscribed(ch.id);
	btn.textContent = on ? "✓ Subscribed" : "+ Subscribe";
	btn.classList.toggle("primary", !on);
	btn.classList.toggle("secondary", on);
	btn.setAttribute("aria-pressed", String(on));
}

for (const t of $$("[data-lib-tab]")) t.addEventListener("click", () => navigate(withParams({ view: "library", tab: t.dataset.libTab, ids: null, name: null }), { replace: true }));
store.onChange(() => {
	renderGuide();
	if (currentView === "home") renderHomeShelves();
	if (currentView === "library" && params().get("view") === "library") renderLibrary();
	updateWatchLibraryButtons();
	renderUpNext();
	updateSubButton();
});

// ---------- Import from Spotify ----------

// Lives outside renderLibrary so the Library re-rendering (it does on every store change)
// doesn't lose an import in progress.
const spotifyJob = { running: false, done: 0, total: 0, controller: null, result: null, error: "", link: "" };

function spotifyPanel() {
	const wrap = h("div", { id: "spotify-import", class: "side-panel spotify-import" });
	fillSpotifyPanel(wrap);
	return wrap;
}

function refreshSpotifyPanel() {
	const el = $("#spotify-import");
	if (el) fillSpotifyPanel(el);
}

function fillSpotifyPanel(wrap) {
	const j = spotifyJob;
	const input = h("input", { type: "url", placeholder: "https://open.spotify.com/playlist/…", "aria-label": "Spotify playlist or album link", value: j.link, disabled: j.running });
	const kids = [
		h("h3", {}, "Import from Spotify"),
		h("p", { class: "muted" }, "Paste a public Spotify playlist or album link. Each song is matched to its YouTube version and saved as one of your playlists."),
		h(
			"form",
			{ class: "lib-actions", onsubmit: (e) => (e.preventDefault(), startSpotifyImport(input.value)) },
			input,
			j.running
				? h("button", { type: "button", class: "button small secondary", onclick: () => j.controller?.abort() }, "Cancel")
				: h("button", { type: "submit", class: "button small primary" }, "Import"),
		),
	];
	if (j.running) {
		const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
		kids.push(h("p", { class: "muted", role: "status" }, j.total ? `Matching songs… ${j.done} / ${j.total}` : "Reading the playlist…"), h("div", { class: "vote-bar import-progress" }, h("span", { style: `width:${pct}%` })));
	} else if (j.error) {
		kids.push(h("p", { class: "import-error", role: "alert" }, j.error));
	} else if (j.result) {
		const r = j.result;
		kids.push(
			h("p", { role: "status" }, `Saved “${r.name}”: ${r.videos.length} of ${r.total} songs found.`),
			r.mayBeTruncated ? h("p", { class: "muted" }, "Spotify only shows the first 100 songs of long playlists, so later songs weren't imported.") : null,
			r.unsure.length ? h("details", {}, h("summary", {}, `${r.unsure.length} guessed — check these`), h("ul", { class: "import-list" }, r.unsure.map((s) => h("li", {}, s)))) : null,
			r.unmatched.length ? h("details", {}, h("summary", {}, `${r.unmatched.length} not found on YouTube`), h("ul", { class: "import-list" }, r.unmatched.map((s) => h("li", {}, s)))) : null,
		);
	}
	wrap.replaceChildren(...kids.filter(Boolean));
}

async function startSpotifyImport(link) {
	const j = spotifyJob;
	if (j.running || !link.trim()) return;
	Object.assign(j, { running: true, done: 0, total: 0, result: null, error: "", link: link.trim(), controller: new AbortController() });
	refreshSpotifyPanel();
	try {
		const r = await importSpotify(link, (done, total) => {
			j.done = done;
			j.total = total;
			refreshSpotifyPanel();
		}, j.controller.signal);
		if (!r.videos.length) throw new Error("None of the songs could be found on YouTube.");
		const saved = store.createPlaylist(r.name, r.videos);
		if (!saved) throw new Error("You've reached the playlist limit. Delete one and try again.");
		Object.assign(j, { result: r, link: "" });
		toast(`Imported “${r.name}” from Spotify`);
	} catch (err) {
		j.error = err.name === "AbortError" ? "Import cancelled." : `Couldn't import: ${err.message}`;
	} finally {
		j.running = false;
		refreshSpotifyPanel();
	}
}

async function renderShared(name, ids) {
	libBody.replaceChildren(h("p", { class: "muted" }, "Loading shared playlist…"));
	for (const t of $$("[data-lib-tab]")) t.setAttribute("aria-selected", "false");
	const videos = [];
	const queue = ids.filter(isVideoId).slice(0, 50);
	await Promise.all(
		Array.from({ length: 4 }, async () => {
			while (queue.length) {
				const id = queue.shift();
				try {
					const d = await api(`/api/video/${id}`);
					videos.push({ order: ids.indexOf(id), video: minVideo({ id, title: d.title, author: d.author, duration: d.lengthSeconds ? fmtTime(d.lengthSeconds) : "" }) });
				} catch {
					/* skip missing videos */
				}
			}
		}),
	);
	const list = videos.sort((a, b) => a.order - b.order).map((x) => x.video);
	libBody.replaceChildren(
		h("h2", { class: "section-title" }, name || "Shared playlist"),
		h("div", { class: "lib-actions" }, h("button", { type: "button", class: "button small primary", onclick: () => playList(list), disabled: !list.length }, "▶ Play all"), h("button", { type: "button", class: "button small secondary", onclick: () => (store.createPlaylist(name || "Shared playlist", list), toast("Saved to your playlists")), disabled: !list.length }, "Save to my playlists")),
		list.length ? h("ol", { class: "row-list" }, list.map((v) => rowItem(v, [iconBtn("+", "Add to queue", () => addToQueue(v))]))) : h("div", { class: "empty" }, h("p", {}, "None of these videos could be loaded.")),
	);
}

// ---------------------------------------------------------------------------------------------
// Channel & playlist pages
// ---------------------------------------------------------------------------------------------

const chState = { key: "", ref: "", tab: "videos", next: null, loading: false, channel: null };

async function loadChannel(ref, tab, append = false) {
	if (chState.loading) return;
	chState.loading = true;
	$("#ch-more").hidden = true;
	if (!append) {
		chState.next = null;
		chState.channel = null;
		updateSubButton();
		$("#ch-results").replaceChildren(...skeletons(8));
		for (const t of $$("[data-ch-tab]")) t.setAttribute("aria-selected", String(t.dataset.chTab === tab));
	}
	try {
		const d = await api(`/api/channel/${encodeURIComponent(ref)}`, { tab, page: append ? chState.next : "", gl: settings.region });
		if (!append) {
			$("#ch-title").textContent = d.title || ref;
			$("#ch-meta").textContent = [d.handle, d.subscribers, d.videoCount].filter(Boolean).join(" · ");
			$("#ch-desc").textContent = d.description || "";
			const av = $("#ch-avatar");
			av.hidden = !safeUrl(d.avatar);
			if (safeUrl(d.avatar)) av.src = d.avatar;
			$("#ch-banner").style.backgroundImage = safeUrl(d.banner) ? `url("${d.banner.replace(/"/g, "")}")` : "";
			$("#ch-banner").hidden = !safeUrl(d.banner);
			$("#ch-yt").href = safeUrl(d.url) || "#";
			chState.channel = d.id ? { id: d.id, title: d.title || ref, handle: d.handle, avatar: safeUrl(d.avatar) } : null;
			updateSubButton();
			showView("channel", d.title || ref);
			$("#ch-results").replaceChildren();
		}
		$("#ch-results").append(...d.results.map(renderCard).filter(Boolean));
		if (!append && !d.results.length) $("#ch-results").replaceChildren(h("div", { class: "empty" }, h("p", {}, "Nothing here.")));
		if (settings.dearrow) applyDeArrow(d.results);
		chState.next = d.next;
		$("#ch-more").hidden = !d.next;
	} catch (err) {
		if (!append) $("#ch-results").replaceChildren(h("div", { class: "empty" }, h("p", {}, `Couldn't load this channel: ${err.message}`)));
		else toast(`Couldn't load more: ${err.message}`);
	} finally {
		chState.loading = false;
	}
}
for (const t of $$("[data-ch-tab]")) t.addEventListener("click", () => navigate(withParams({ tab: t.dataset.chTab }), { replace: true }));
$("#ch-more").addEventListener("click", () => loadChannel(chState.ref, chState.tab, true));
$("#ch-sub").addEventListener("click", () => {
	const ch = chState.channel;
	if (!ch?.id) return;
	const before = store.isSubscribed(ch.id);
	const on = store.toggleSubscription(ch);
	if (!before && !on) toast(`You can follow up to ${store.subscriptionLimit} channels`);
	else if (on) toast(`Subscribed to ${ch.title}`, { label: "View feed", run: () => navigate("/?view=library&tab=subs") });
	else toast(`Unsubscribed from ${ch.title}`);
});


const plState = { key: "", id: "", next: null, loading: false, items: [], title: "" };

async function loadPlaylist(id, append = false) {
	if (plState.loading) return;
	plState.loading = true;
	$("#pl-more").hidden = true;
	if (!append) {
		plState.items = [];
		plState.next = null;
		$("#pl-results").replaceChildren(...skeletons(8));
	}
	try {
		const d = await api(`/api/playlist/${encodeURIComponent(id)}`, { page: append ? plState.next : "", gl: settings.region });
		if (!append) {
			plState.title = d.title || "Playlist";
			$("#pl-title").textContent = plState.title;
			$("#pl-meta").textContent = [d.owner, d.videoCount, d.views].filter(Boolean).join(" · ");
			$("#pl-desc").textContent = d.description || "";
			$("#pl-yt").href = `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`;
			showView("playlist", plState.title);
			$("#pl-results").replaceChildren();
		}
		plState.items.push(...d.results);
		$("#pl-results").append(...d.results.map(renderCard).filter(Boolean));
		if (settings.dearrow) applyDeArrow(d.results);
		plState.next = d.next;
		$("#pl-more").hidden = !d.next;
	} catch (err) {
		if (!append) $("#pl-results").replaceChildren(h("div", { class: "empty" }, h("p", {}, `Couldn't load this playlist: ${err.message}`)));
		else toast(`Couldn't load more: ${err.message}`);
	} finally {
		plState.loading = false;
	}
}

async function allPlaylistVideos(max = 300) {
	while (plState.next && plState.items.length < max) await loadPlaylist(plState.id, true);
	return plState.items.map(minVideo).filter(Boolean).slice(0, max);
}
$("#pl-more").addEventListener("click", () => loadPlaylist(plState.id, true));
$("#pl-play").addEventListener("click", async () => playList(await allPlaylistVideos()));
$("#pl-shuffle").addEventListener("click", async () => playList(await allPlaylistVideos(), { shuffle: true }));
$("#pl-queue").addEventListener("click", async () => toast(`Added ${store.enqueue(await allPlaylistVideos())} videos to your queue`));
$("#pl-save").addEventListener("click", async () => (store.createPlaylist(plState.title, await allPlaylistVideos(500)), toast("Saved to your playlists")));
$("#pl-protv").addEventListener("click", () => copy(`${location.origin}/vrc/protv.playlist?list=${encodeURIComponent(plState.id)}&n=200`, "ProTV playlist link"));

// ---------------------------------------------------------------------------------------------
// Watch dialog: YouTube IFrame API on youtube-nocookie + SponsorBlock + chapters + rooms
// ---------------------------------------------------------------------------------------------

const watch = $("#watch");
let ytReady;
let player = null;
let tick = null;
let watchSeq = 0;
let current = null; // { id, video, segments, skipped, muted, duration, chapters, description }

// Watch party
let room = null;
let roomState = null;
let suppressUntil = 0; // ignore our own player events right after applying remote state
let lastTick = { t: 0, wall: 0 };
let pendingPartyVideo = null;

function loadYouTubeApi() {
	if (window.YT?.Player) return Promise.resolve();
	ytReady ??= new Promise((resolve, reject) => {
		window.onYouTubeIframeAPIReady = resolve;
		const s = h("script", { src: "https://www.youtube.com/iframe_api", async: true });
		s.onerror = () => {
			ytReady = undefined;
			reject(new Error("Couldn't load the YouTube player"));
		};
		document.head.append(s);
	});
	return ytReady;
}

function openFromCard(e, item) {
	if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let new-tab clicks through
	e.preventDefault();
	if (room) {
		partySend({ t: "load", video: { id: item.id, title: item.title } });
		return;
	}
	history.pushState({ watch: true }, "", withParams(item.list ? { v: item.id, list: item.list } : { v: item.id }));
	openWatch(item.id, item);
}

function resetWatchUi() {
	for (const id of ["#votes", "#segments", "#desc-wrap", "#full-label", "#jump-highlight", "#watch-original", "#chapters", "#save-menu", "#lyrics"]) $(id).hidden = true;
	lyricLines = [];
	activeLyric = -1;
	$("#seg-bar").replaceChildren();
	$("#watch-stats").textContent = "";
	const ch = $("#watch-channel");
	ch.textContent = "";
	ch.removeAttribute("href");
	ch.removeAttribute("data-internal");
	$("#save-btn").setAttribute("aria-expanded", "false");
}

async function openWatch(id, item = {}, { start = 0 } = {}) {
	const seq = ++watchSeq;
	const list = item.list || params().get("list");
	resetWatchUi();
	$("#player-empty").hidden = true;
	$("#watch-title").textContent = item.branding?.title || item.title || "Loading…";
	if (item.branding?.title) {
		const o = $("#watch-original");
		o.textContent = `Original title: ${item.title}`;
		o.hidden = false;
	}
	const ytUrl = `https://www.youtube.com/watch?v=${id}${list ? `&list=${list}` : ""}`;
	$("#watch-yt").href = ytUrl;
	$("#copy-yt").onclick = () => copy(ytUrl);
	$("#copy-vrc").onclick = () => copy(`https://www.youtube.com/watch?v=${id}`, "VRChat link");
	if (!watch.open) watch.showModal();

	current = { id, video: minVideo({ ...item, id }), segments: [], skipped: new Set(), muted: false, duration: 0, chapters: [], description: "" };
	updateWatchLibraryButtons();
	renderUpNext();
	startPlayer(id, room ? null : list, seq, start);

	try {
		const d = await api(`/api/video/${encodeURIComponent(id)}`, { gl: settings.region });
		if (seq !== watchSeq) return;
		fillDetails(d, item);
	} catch (err) {
		if (seq === watchSeq && !item.title) $("#watch-title").textContent = "Video";
		console.warn(err);
	}
}

async function startPlayer(id, list, seq, start = 0) {
	destroyPlayer();
	const slot = $("#player-slot");
	slot.replaceChildren(h("div", { id: "player" }));
	try {
		await loadYouTubeApi();
	} catch (err) {
		slot.replaceChildren(h("div", { class: "player-error" }, err.message));
		return;
	}
	if (seq !== watchSeq) return;
	const playerVars = {
		autoplay: room ? (roomState?.playing ? 1 : 0) : settings.autoplay ? 1 : 0,
		rel: 0,
		playsinline: 1,
		iv_load_policy: 3,
		origin: location.origin,
		...(start > 1 ? { start: Math.floor(start) } : {}),
		...(settings.captions ? { cc_load_policy: 1 } : {}),
		...(list ? { list, listType: "playlist" } : {}),
	};
	player = new window.YT.Player("player", {
		host: "https://www.youtube-nocookie.com",
		videoId: id,
		playerVars,
		events: {
			onReady: () => {
				current.duration = player.getDuration?.() || current.duration;
				drawSegments();
				if (room && roomState) applyRoomState(roomState, { force: true });
			},
			onStateChange: onPlayerState,
		},
	});
	clearInterval(tick);
	lastTick = { t: start, wall: performance.now() };
	tick = setInterval(skipLoop, 250);
}

function onPlayerState(e) {
	const YTS = window.YT.PlayerState;
	if (!current) return;
	// Embedded YouTube playlist advanced to another video: refresh its details.
	const vid = player?.getVideoData?.().video_id;
	if (!room && vid && vid !== current.id && e.data === YTS.PLAYING) {
		history.replaceState(history.state, "", withParams({ v: vid }));
		openWatchDetailsOnly(vid);
		return;
	}
	if (room) {
		if (performance.now() < suppressUntil) return;
		const t = player.getCurrentTime?.() || 0;
		if (e.data === YTS.ENDED) room.send({ t: "ended", id: current.id });
		else if (e.data === YTS.PLAYING && !roomState?.playing) partySend({ t: "play", position: t }, { quiet: true });
		else if (e.data === YTS.PAUSED && roomState?.playing) partySend({ t: "pause", position: t }, { quiet: true });
		return;
	}
	if (e.data === YTS.ENDED && sleepAtEnd) {
		sleepAtEnd = false;
		$("#sleep-select").value = "";
		toast("Sleep timer: goodnight");
		return;
	}
	if (e.data === YTS.ENDED && settings.autoNext && !params().get("list")) playNextInQueue();
}

function playNextInQueue() {
	const next = store.dequeue();
	if (!next) return false;
	history.replaceState({ watch: true }, "", withParams({ v: next.id, list: null }));
	openWatch(next.id, next);
	return true;
}

async function openWatchDetailsOnly(id) {
	const seq = ++watchSeq;
	current = { id, video: minVideo({ id }), segments: [], skipped: new Set(), muted: false, duration: 0, chapters: [], description: "" };
	resetWatchUi();
	$("#watch-yt").href = `https://www.youtube.com/watch?v=${id}`;
	try {
		const d = await api(`/api/video/${encodeURIComponent(id)}`, { gl: settings.region });
		if (seq === watchSeq) fillDetails(d, {});
	} catch {
		/* ignore */
	}
}

function fillDetails(d, item) {
	const title = settings.dearrow && d.dearrow?.title ? d.dearrow.title : d.title;
	$("#watch-title").textContent = title || item.title || "Video";
	if (title && d.title && title !== d.title) {
		const o = $("#watch-original");
		o.textContent = `Original title: ${d.title}`;
		o.hidden = false;
	}
	const ch = $("#watch-channel");
	ch.textContent = d.author || item.channel?.name || "";
	if (d.channelId) {
		ch.href = `/?channel=${encodeURIComponent(d.channelId)}`;
		ch.setAttribute("data-internal", "");
		ch.removeAttribute("target");
	} else if (safeUrl(d.channelUrl)) ch.href = d.channelUrl;
	const views = d.viewCount ?? d.votes?.viewCount;
	const date = d.publishDate ? new Date(d.publishDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : item.published;
	$("#watch-stats").textContent = [views != null ? `${fmtCount(views)} views` : item.views, date].filter(Boolean).join(" · ");

	if (settings.dislikes && d.votes && d.votes.likes + d.votes.dislikes > 0) {
		const { likes, dislikes } = d.votes;
		$("#likes").textContent = `👍 ${fmtCount(likes)}`;
		$("#dislikes").textContent = `👎 ${fmtCount(dislikes)}`;
		$("#vote-fill").style.width = `${((likes / (likes + dislikes)) * 100).toFixed(1)}%`;
		$("#votes").hidden = false;
	}
	if (d.description) {
		$("#watch-desc").textContent = d.description;
		$("#desc-wrap").hidden = false;
	}

	current.video = minVideo({ ...item, id: current.id, title: d.title || item.title, author: d.author, channelRef: d.channelId, duration: item.duration || (d.lengthSeconds ? fmtTime(d.lengthSeconds) : ""), live: d.isLive });
	if (!room) store.addHistory(current.video);
	updateWatchLibraryButtons();
	loadLyrics(d, current.id);

	current.segments = settings.sponsorblock ? d.sponsorblock || [] : [];
	current.duration = d.lengthSeconds || current.segments[0]?.videoDuration || current.duration;
	current.description = d.description || "";
	const { source, chapters } = bestChapters(current.description, current.segments);
	current.chapters = chapters;
	renderChapters(source);
	renderSegments();
}

// ---------- SponsorBlock ----------

function renderSegments() {
	const segs = current.segments;
	const full = segs.find((s) => s.action === "full");
	if (full) {
		const fl = $("#full-label");
		fl.textContent = `Heads up: this whole video is labeled “${SB[full.category]?.label || full.category}” on SponsorBlock.`;
		fl.hidden = false;
	}
	const poi = segs.find((s) => s.action === "poi");
	const jump = $("#jump-highlight");
	if (poi) {
		jump.hidden = false;
		jump.onclick = () => seek(poi.start);
	}
	const listed = segs.filter((s) => s.action === "skip" || s.action === "mute");
	if (listed.length) {
		$("#segments").replaceChildren(
			h("h3", {}, "SponsorBlock segments"),
			h(
				"ul",
				{},
				listed.map((s) => {
					const info = SB[s.category] || { label: s.category, color: "#888" };
					const auto = settings.skip[s.category];
					return h(
						"li",
						{},
						h("span", { class: "swatch", style: `background:${info.color}` }),
						h("span", { class: "seg-label" }, info.label),
						h("span", { class: "muted" }, `${fmtTime(s.start)}–${fmtTime(s.end)}`),
						h("span", { class: auto ? "tag on" : "tag" }, s.action === "mute" ? (auto ? "auto-mute" : "mute") : auto ? "auto-skip" : "manual"),
						h("button", { type: "button", class: "button tiny secondary", onclick: () => seek(s.end) }, "Skip"),
					);
				}),
			),
		);
		$("#segments").hidden = false;
	}
	drawSegments();
}

function drawSegments() {
	const bar = $("#seg-bar");
	const dur = current?.duration || player?.getDuration?.() || 0;
	if (!dur || (!current?.segments.length && !current?.chapters.length)) return bar.replaceChildren();
	bar.replaceChildren(
		...current.segments
			.filter((s) => s.action !== "full" && s.action !== "chapter")
			.map((s) => {
				const info = SB[s.category] || { label: s.category, color: "#888" };
				return h("span", { style: `left:${(s.start / dur) * 100}%;width:${Math.max(((s.end - s.start) / dur) * 100, 0.4)}%;background:${info.color}`, title: `${info.label} ${fmtTime(s.start)}–${fmtTime(s.end)}` });
			}),
		...current.chapters.slice(1).map((c) => h("i", { class: "chapter-tick", style: `left:${(c.start / dur) * 100}%`, title: `${fmtTime(c.start)} ${c.title}` })),
	);
}

/** Seek locally; in a watch party the change is broadcast by the tick loop's jump detection. */
function seek(t) {
	player?.seekTo?.(t, true);
}

function skipLoop() {
	if (!player?.getCurrentTime || !current) return;
	let t;
	try {
		t = player.getCurrentTime();
	} catch {
		return;
	}
	const now = performance.now();

	// Watch party: detect seeks the user made in the YouTube controls and share them.
	if (room && roomState?.video?.id === current.id && now > suppressUntil) {
		const expected = lastTick.t + (player.getPlayerState?.() === window.YT?.PlayerState?.PLAYING ? (now - lastTick.wall) / 1000 : 0);
		if (Math.abs(t - expected) > 2.5) partySend({ t: "seek", position: t }, { quiet: true });
	}
	lastTick = { t, wall: now };
	updateActiveChapter(t);
	updateActiveLyric(t);

	let inMute = false;
	for (const s of current.segments) {
		if (!settings.skip[s.category]) continue;
		const inside = t >= s.start && t < s.end - 0.35;
		if (s.action === "skip" && inside && !current.skipped.has(s.uuid)) {
			current.skipped.add(s.uuid);
			// Everyone in a party skips on their own; don't broadcast it as a seek.
			suppressUntil = now + 1200;
			player.seekTo(s.end, true);
			lastTick = { t: s.end, wall: now };
			const label = SB[s.category]?.label || s.category;
			toast(`Skipped ${label} (${fmtTime(s.end - s.start)})`, { label: "Undo", run: () => seek(s.start) });
		}
		if (s.action === "mute" && inside) inMute = true;
	}
	if (inMute && !current.muted) {
		current.muted = true;
		player.mute();
	} else if (!inMute && current.muted) {
		current.muted = false;
		player.unMute();
	}
}

// ---------- Chapters (description timestamps or SponsorBlock chapters) ----------

function renderChapters(source) {
	const box = $("#chapters");
	const hasDesc = !!current.description;
	box.hidden = !current.chapters.length && !hasDesc;
	$("#chapters-source").textContent = source === "sponsorblock" ? "from SponsorBlock" : source === "description" ? "from the description" : "";
	$("#chapters-search").value = "";
	$("#chapters-search").placeholder = current.chapters.length ? "Search chapters and description" : "Search the description";
	fillChapterList("");
}

function fillChapterList(query) {
	const q = query.trim().toLowerCase();
	const list = $("#chapters-list");
	const items = current.chapters.filter((c) => !q || c.title.toLowerCase().includes(q)).map((c) => h("li", {}, h("button", { type: "button", class: "chapter-btn", "data-start": c.start, onclick: () => seek(c.start) }, h("span", { class: "chapter-time" }, fmtTime(c.start)), h("span", {}, c.title))));
	if (q && current.description) {
		// Description lines that match; timestamps inside them become clickable.
		const lines = current.description.split(/\r?\n/).filter((l) => l.toLowerCase().includes(q)).slice(0, 12);
		for (const l of lines) {
			const m = /((?:\d{1,2}:)?\d{1,2}:\d{2})/.exec(l);
			items.push(h("li", { class: "desc-hit" }, m ? h("button", { type: "button", class: "chapter-btn", onclick: () => seek(toSeconds(m[1])) }, h("span", { class: "chapter-time" }, m[1]), h("span", {}, l.trim())) : h("span", { class: "muted" }, l.trim())));
		}
	}
	list.replaceChildren(...(items.length ? items : [h("li", { class: "muted" }, q ? "No matches." : "No chapters for this video.")]));
}
$("#chapters-search").addEventListener("input", (e) => fillChapterList(e.target.value));

let activeChapterStart = -1;
function updateActiveChapter(t) {
	if (!current?.chapters.length) return;
	let start = -1;
	for (const c of current.chapters) if (c.start <= t + 0.5) start = c.start;
	if (start === activeChapterStart) return;
	activeChapterStart = start;
	for (const b of $$("#chapters-list .chapter-btn[data-start]")) b.classList.toggle("active", Number(b.dataset.start) === start);
}

// ---------- Library buttons, save menu, up next ----------

function updateWatchLibraryButtons() {
	$("#queue-btn").textContent = room ? "+ Add to party" : "+ Queue";
	$("#party-btn").hidden = !!room;
	$(".library-actions").hidden = !current;
	if (!current) return;
	const fav = store.isFavorite(current.id);
	const b = $("#fav-btn");
	b.textContent = fav ? "♥ Favorited" : "♡ Favorite";
	b.setAttribute("aria-pressed", String(fav));
}

$("#fav-btn").addEventListener("click", () => current && toggleFav(current.video) && updateWatchLibraryButtons());
$("#queue-btn").addEventListener("click", () => current?.video && addToQueue(current.video));
$("#save-btn").addEventListener("click", () => {
	const menu = $("#save-menu");
	menu.hidden = !menu.hidden;
	$("#save-btn").setAttribute("aria-expanded", String(!menu.hidden));
	if (menu.hidden) return;
	const sel = $("#save-select");
	const lists = store.get().playlists;
	sel.replaceChildren(...lists.map((p) => h("option", { value: p.id }, `${p.name} (${p.items.length})`)), h("option", { value: "" }, lists.length ? "— New playlist —" : "New playlist"));
	sel.value = lists[0]?.id || "";
});
$("#save-menu").addEventListener("submit", (e) => {
	e.preventDefault();
	if (!current?.video) return;
	const name = $("#save-new").value.trim();
	const id = $("#save-select").value;
	if (name || !id) {
		store.createPlaylist(name || "My playlist", [current.video]);
		toast(`Saved to “${name || "My playlist"}”`);
	} else {
		toast(store.addToPlaylist(id, current.video) ? `Saved to “${store.playlist(id)?.name}”` : "Already in that playlist");
	}
	$("#save-new").value = "";
	$("#save-menu").hidden = true;
	$("#save-btn").setAttribute("aria-expanded", "false");
});

function renderUpNext() {
	const box = $("#upnext");
	if (!watch.open) return;
	const list = room ? roomState?.queue || [] : store.get().queue;
	box.hidden = !list.length;
	$("#upnext-count").textContent = list.length ? `(${list.length})` : "";
	$("#upnext-list").replaceChildren(
		...list.slice(0, 50).map((v, i) =>
			h(
				"li",
				{},
				h("span", { class: "upnext-title" }, v.title),
				room
					? h("button", { type: "button", class: "button tiny secondary", "aria-label": "Remove from party queue", onclick: () => partySend({ t: "queue_remove", index: i }) }, "✕")
					: [
							h("button", { type: "button", class: "button tiny secondary", "aria-label": "Play now", onclick: () => (store.removeFromQueue(i), history.replaceState({ watch: true }, "", withParams({ v: v.id })), openWatch(v.id, v)) }, "▶"),
							h("button", { type: "button", class: "button tiny secondary", "aria-label": "Remove from queue", onclick: () => store.removeFromQueue(i) }, "✕"),
						],
			),
		),
	);
}

// ---------- Watch party ----------

async function startParty() {
	let code;
	try {
		let hostKey;
		({ code, hostKey } = await api("/api/rooms/new"));
		if (hostKey) hostKeys.set(code, hostKey);
	} catch (err) {
		toast(`Couldn't create a room: ${err.message}`);
		return;
	}
	// Keep the current video playing: it becomes the room's first video.
	if (current) pendingPartyVideo = { video: { id: current.id, title: current.video?.title || current.id }, position: player?.getCurrentTime?.() || 0 };
	navigate(withParams({ room: code, v: null, list: null }), { replace: !!current });
}
$("#party-btn").addEventListener("click", () => startParty());

function openRoom(code) {
	if (room?.code === code) return;
	room?.close();
	roomState = null;
	room = new RoomClient(code, {
		onState: (s) => {
			const first = !roomState;
			roomState = s;
			if (first && !s.video && pendingPartyVideo) {
				const { video, position } = pendingPartyVideo;
				pendingPartyVideo = null;
				room.send({ t: "load", video });
				if (position > 2) setTimeout(() => room?.send({ t: "seek", position }), 300);
			}
			applyRoomState(s);
			renderUpNext();
			renderRoomRole();
		},
		onMembers: (m) => {
			const names = m.names?.length ? `: ${m.names.slice(0, 6).join(", ")}${m.names.length > 6 ? "…" : ""}` : "";
			const hosts = m.hosts?.length ? ` · host: ${m.hosts.slice(0, 2).join(", ")}` : "";
			$("#room-members").textContent = `· ${m.count} watching${names}${hosts}`;
		},
		onRole: () => renderRoomRole(),
		onDenied: (reason) => toast(reason === "not_host" ? "Only the host can change that" : "The host has locked this room"),
		onStatus: (s) => ($("#room-status").textContent = s === "connected" ? "" : s === "full" ? "· room is full" : `· ${s}…`),
	});
	room.name = settings.partyName || "Guest";
	room.connect();
	$("#room-code").textContent = code;
	$("#room-bar").hidden = false;
	$("#room-invite").onclick = () => copy(`${location.origin}/?room=${code}`, "Invite link");
	$("#room-vrc").onclick = () => copy(`${location.origin}/room/${code}`, "VRChat room link");
	if (!watch.open) watch.showModal();
	if (!current) {
		$("#watch-title").textContent = "Waiting for a video…";
		showEmptyPlayer("Nothing is playing yet. Search below to add the first video.");
	}
	updateWatchLibraryButtons();
}

function showEmptyPlayer(message) {
	$("#player-slot").replaceChildren();
	const e = $("#player-empty");
	e.textContent = message;
	e.hidden = false;
}

function applyRoomState(s, { force = false } = {}) {
	if (!room) return;
	if (!s.video) {
		if (current) {
			destroyPlayer();
			current = null;
			resetWatchUi();
		}
		$("#watch-title").textContent = "Waiting for a video…";
		showEmptyPlayer("Nothing is playing. Search below to add a video.");
		return;
	}
	$("#player-empty").hidden = true;
	const target = room.positionOf(s);
	if (!current || current.id !== s.video.id) {
		suppressUntil = performance.now() + 2500;
		openWatch(s.video.id, { id: s.video.id, title: s.video.title }, { start: target });
		return;
	}
	if (!player?.getCurrentTime) return;
	const YTS = window.YT.PlayerState;
	const t = player.getCurrentTime();
	const playing = player.getPlayerState?.() === YTS.PLAYING || player.getPlayerState?.() === YTS.BUFFERING;
	if (force || Math.abs(t - target) > 1.5) {
		suppressUntil = performance.now() + 1200;
		player.seekTo(target, true);
		lastTick = { t: target, wall: performance.now() };
	}
	if (s.playing && !playing) {
		suppressUntil = performance.now() + 1200;
		player.playVideo();
	} else if (!s.playing && playing) {
		suppressUntil = performance.now() + 1200;
		player.pauseVideo();
	}
}

/**
 * Sends a playback/queue change to the room. In a host-locked room, guests can't: their player is
 * put back in sync instead. Returns whether the message was sent.
 */
function partySend(msg, { quiet = false } = {}) {
	if (!room) return false;
	if (room.canControl(roomState)) {
		room.send(msg);
		return true;
	}
	if (!quiet) toast("The host has locked this room");
	if (roomState) applyRoomState(roomState, { force: true });
	return false;
}

function renderRoomRole() {
	if (!room) return;
	const locked = !!roomState?.locked;
	const lockBtn = $("#room-lock");
	lockBtn.hidden = !room.isHost;
	lockBtn.textContent = locked ? "🔒 Host only" : "🔓 Everyone can control";
	lockBtn.setAttribute("aria-pressed", String(locked));
	lockBtn.title = locked ? "Only hosts can control playback and the queue. Click to let everyone control it." : "Everyone can control playback and the queue. Click to make it host-only.";
	$("#room-role").textContent = room.isHost ? "· you're the host" : locked ? "· host controls playback" : "";
	const guestLocked = locked && !room.isHost;
	$("#room-add").hidden = guestLocked;
	if (guestLocked) $("#room-add-results").hidden = true;
}
$("#room-lock").addEventListener("click", () => room?.isHost && room.send({ t: "lock", locked: !roomState?.locked }));

function leaveRoom() {
	room?.close();
	room = null;
	roomState = null;
	$("#room-bar").hidden = true;
	$("#room-add-results").hidden = true;
	updateWatchLibraryButtons();
}
$("#room-leave").addEventListener("click", () => requestCloseWatch());

$("#room-add").addEventListener("submit", async (e) => {
	e.preventDefault();
	const q = $("#room-add-q").value.trim();
	const list = $("#room-add-results");
	if (!q) return;
	list.hidden = false;
	list.replaceChildren(h("li", { class: "muted" }, "Searching…"));
	try {
		const d = await api("/api/search", { q, type: "video", shorts: "0", gl: settings.region });
		const vids = d.results.filter((r) => r.type === "video" && !r.upcoming).slice(0, 8);
		list.replaceChildren(
			...vids.map((v) =>
				h(
					"li",
					{},
					h("img", { src: safeUrl(v.thumbnail), alt: "", loading: "lazy", referrerpolicy: "no-referrer" }),
					h("span", { class: "upnext-title" }, v.title, h("small", { class: "muted" }, ` ${[v.channel?.name, v.live ? "LIVE" : v.duration].filter(Boolean).join(" · ")}`)),
					h("button", { type: "button", class: "button tiny primary", onclick: () => partySend({ t: "queue_add", video: { id: v.id, title: v.title } }) && toast(roomState?.video ? "Added to the party queue" : "Playing now") }, "+ Add"),
					h("button", { type: "button", class: "button tiny secondary", onclick: () => partySend({ t: "load", video: { id: v.id, title: v.title } }) }, "Play now"),
				),
			),
		);
		if (!vids.length) list.replaceChildren(h("li", { class: "muted" }, "No results."));
	} catch (err) {
		list.replaceChildren(h("li", { class: "muted" }, `Search failed: ${err.message}`));
	}
});

// ---------- Close ----------

function destroyPlayer() {
	clearInterval(tick);
	tick = null;
	try {
		player?.destroy?.();
	} catch {
		/* ignore */
	}
	player = null;
}

function closeWatch({ leaveRoom: leave = true } = {}) {
	watchSeq++;
	destroyPlayer();
	$("#player-slot").replaceChildren();
	current = null;
	activeChapterStart = -1;
	if (leave) leaveRoom();
	if (watch.open) watch.close();
}

function requestCloseWatch() {
	if (history.state?.watch) history.back(); // popstate will close it
	else {
		history.replaceState({}, "", withParams({ v: null, room: null }));
		closeWatch();
	}
}

watch.addEventListener("cancel", (e) => {
	e.preventDefault();
	requestCloseWatch();
});
watch.addEventListener("click", (e) => {
	if (e.target === watch || e.target.closest("[data-close-watch]")) requestCloseWatch();
});

// ---------------------------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------------------------

const settingsDlg = $("#settings");
$("#sb-settings").replaceChildren(
	...Object.entries(SB)
		.filter(([k]) => k !== "poi_highlight")
		.map(([k, v]) => h("label", { class: "toggle" }, h("input", { type: "checkbox", "data-skip": k }), h("span", { class: "swatch", style: `background:${v.color}` }), v.label)),
);
function syncSettingsForm() {
	for (const el of $$("[data-setting]", settingsDlg)) {
		if (el.type === "checkbox") el.checked = !!settings[el.dataset.setting];
		else el.value = settings[el.dataset.setting] ?? "";
	}
	for (const el of $$("[data-skip]", settingsDlg)) el.checked = !!settings.skip[el.dataset.skip];
}
settingsDlg.addEventListener("change", (e) => {
	const el = e.target;
	if (el.dataset.setting) settings[el.dataset.setting] = el.type === "checkbox" ? el.checked : el.value.trim();
	if (el.dataset.skip) settings.skip[el.dataset.skip] = el.checked;
	saveSettings();
	if (el.dataset.setting === "partyName") room?.setName(settings.partyName || "Guest");
	applyPlugins();
	if (["hideShorts", "dearrow", "region"].includes(el.dataset.setting) && state.q && currentView === "results") runSearch();
});
$("#open-settings").addEventListener("click", () => {
	syncSettingsForm();
	renderThemeCards();
	settingsDlg.showModal();
});
settingsDlg.addEventListener("click", (e) => e.target === settingsDlg && settingsDlg.close());

// ---------------------------------------------------------------------------------------------
// Plugins & themes (same names as BetterYTS Music: SponsorBlock, Return YouTube Dislike, DeArrow,
// Synced lyrics, Sleep timer, VRChat bridge)
// ---------------------------------------------------------------------------------------------

function renderThemeCards() {
	const now = currentTheme();
	$("#theme-cards").replaceChildren(
		...THEMES.map((t) =>
			h(
				"button",
				{
					type: "button",
					class: "theme-card",
					role: "radio",
					"aria-checked": String(t.id === now),
					style: `background:${t.bg}`,
					onclick: () => {
						setTheme(t.id);
						renderThemeCards();
					},
				},
				h("b", { style: `color:${t.swatches[0]}` }, t.name),
				h("span", { class: "theme-swatches" }, t.swatches.map((c) => h("i", { style: `background:${c}` }))),
				h("small", {}, t.id === now ? `${t.note} · in use` : t.note),
			),
		),
	);
}

/** Shows or hides plugin-owned controls to match the settings. */
function applyPlugins() {
	for (const id of ["#copy-vrc", "#room-vrc", "#pl-protv", "#copy-vrc-search"]) {
		const el = $(id);
		if (el) el.hidden = !settings.vrchat;
	}
	$("#sleep-wrap").hidden = !settings.sleep;
	if (!settings.sleep) cancelSleep();
	if (!settings.lyrics) $("#lyrics").hidden = true;
}

// ---- Synced lyrics (LRCLIB via /api/lyrics). Only for videos YouTube files under Music. ----
let lyricLines = [];
let activeLyric = -1;

async function loadLyrics(d, id) {
	if (!settings.lyrics || d.category !== "Music" || d.isLive) return;
	try {
		const res = await api("/api/lyrics", { title: d.title || "", channel: d.author || "", duration: d.lengthSeconds || "" });
		if (current?.id !== id || !res.lyrics) return;
		const { synced, plain, instrumental } = res.lyrics;
		$("#lyrics-source").textContent = `· ${res.artist} — ${res.track} · LRCLIB`;
		lyricLines = synced || [];
		activeLyric = -1;
		const list = $("#lyrics-list");
		if (lyricLines.length) {
			list.replaceChildren(...lyricLines.map((l, i) => h("li", {}, h("button", { type: "button", class: "lyric", "data-i": i, onclick: () => seek(l.time) }, l.text || "♪"))));
		} else if (plain) {
			list.replaceChildren(...plain.split("\n").map((l) => h("li", { class: "lyric plain" }, l)));
		} else if (instrumental) {
			list.replaceChildren(h("li", { class: "lyric plain" }, "Instrumental"));
		} else return;
		$("#lyrics").hidden = false;
	} catch {
		/* no lyrics: the panel just stays hidden */
	}
}

function updateActiveLyric(t) {
	if (!lyricLines.length) return;
	let i = -1;
	for (let k = 0; k < lyricLines.length && lyricLines[k].time <= t + 0.3; k++) i = k;
	if (i === activeLyric) return;
	activeLyric = i;
	const list = $("#lyrics-list");
	for (const b of $$(".lyric.active", list)) b.classList.remove("active");
	const el = list.querySelector(`.lyric[data-i="${i}"]`);
	if (el) {
		el.classList.add("active");
		// Keep the current line in view inside the panel without scrolling the dialog.
		list.scrollTop = el.offsetTop - list.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
	}
}

// ---- Sleep timer ----
let sleepTimer = null;
let sleepAtEnd = false;

function cancelSleep() {
	clearTimeout(sleepTimer);
	sleepTimer = null;
	sleepAtEnd = false;
	$("#sleep-select").value = "";
}

$("#sleep-select").addEventListener("change", (e) => {
	const v = e.target.value;
	clearTimeout(sleepTimer);
	sleepTimer = null;
	sleepAtEnd = v === "end";
	if (v && v !== "end") {
		sleepTimer = setTimeout(() => {
			player?.pauseVideo?.();
			$("#sleep-select").value = "";
			toast("Sleep timer: goodnight");
		}, Number(v) * 60_000);
		toast(`Playback stops in ${v} min`);
	} else if (v === "end") toast("Playback stops at the end of this video");
});

// ---- YouTube-style guide: library sections + your subscriptions ----
function renderGuide() {
	const guide = $("#guide");
	if (!guide || guide.hidden) return;
	const p = params();
	const tab = p.get("view") === "library" ? p.get("tab") || "queue" : currentView === "home" ? "home" : "";
	for (const a of $$("[data-guide]", guide)) a.classList.toggle("active", a.dataset.guide === tab);
	const subs = store.get().subscriptions;
	$("#guide-subs-wrap").hidden = !subs.length;
	$("#guide-subs").replaceChildren(
		...subs.slice(0, 30).map((c) =>
			h(
				"a",
				{ class: "guide-link guide-channel", href: `/?channel=${encodeURIComponent(c.id)}`, "data-internal": true },
				safeUrl(c.avatar) ? h("img", { src: safeUrl(c.avatar), alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "avatar ph" }),
				h("span", {}, c.title),
			),
		),
	);
}

// ---- Home: personal shelves (only when there's something of yours to show) ----
async function renderHomeShelves() {
	const box = $("#home-shelves");
	const { history, subscriptions } = store.get();
	if (!history.length && !subscriptions.length) {
		box.hidden = true;
		return;
	}
	const shelf = (eyebrow, title, items, all) =>
		h(
			"section",
			{ class: "shelf" },
			h("div", { class: "shelf-head" }, h("div", {}, h("p", { class: "eyebrow" }, eyebrow), h("h2", { class: "shelf-title" }, title)), all ? h("a", { class: "button small secondary", href: all, "data-internal": true }, "See all") : null),
			h("div", { class: "shelf-row" }, items.map((v) => videoCard(v))),
		);
	const parts = [];
	if (history.length) parts.push(shelf("Pick up where you left off", "Continue watching", history.slice(0, 12), "/?view=library&tab=history"));
	box.replaceChildren(...parts);
	box.hidden = false;
	if (subscriptions.length) {
		const key = subscriptions.map((c) => c.id).sort().join(",");
		if (subsFeed.key !== key || !subsFeed.items) await loadFeed(subscriptions, key);
		if (currentView !== "home" || !subsFeed.items?.length) return;
		box.append(shelf("From channels you follow", "Subscriptions", subsFeed.items.slice(0, 12), "/?view=library&tab=subs"));
	}
}

applyPlugins();

// ---------------------------------------------------------------------------------------------
// VRChat link helpers, keyboard, routing, boot
// ---------------------------------------------------------------------------------------------

const vrcSearchUrl = (q) => `${location.origin}/search?q=${encodeURIComponent(q).replace(/%20/g, "+")}`;
$("#vrc-example .origin").textContent = location.origin;
$("[data-copy-example]").addEventListener("click", () => copy(`${location.origin}/search?q=`, "VRChat URL"));
$("#copy-vrc-search").addEventListener("click", () => state.q && copy(vrcSearchUrl(state.q), "VRChat link"));

document.addEventListener("keydown", (e) => {
	if (e.key === "/" && document.activeElement !== input && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !watch.open) {
		e.preventDefault();
		input.focus();
		input.select();
	}
});

function syncFromUrl() {
	const p = params();
	const view = p.get("view");
	const channelRef = p.get("channel");
	const list = p.get("list");
	const roomCode = (p.get("room") || "").toUpperCase();
	const v = p.get("v");

	// ---- Page behind the player ----
	if (view === "library") {
		libTab = ["subs", "queue", "favorites", "history", "playlists", "party"].includes(p.get("tab")) ? p.get("tab") : "queue";
		showView("library", "Your library");
		renderLibrary();
	} else if (view === "shared") {
		showView("library", p.get("name") || "Shared playlist");
		renderShared(p.get("name") || "", (p.get("ids") || "").split(","));
	} else if (channelRef) {
		const tab = ["videos", "live", "shorts", "playlists"].includes(p.get("tab")) ? p.get("tab") : "videos";
		const key = `${channelRef}|${tab}`;
		if (key !== chState.key) {
			chState.key = key;
			chState.ref = channelRef;
			chState.tab = tab;
			showView("channel", channelRef);
			loadChannel(channelRef, tab);
		} else showView("channel", $("#ch-title").textContent || channelRef);
	} else if (list && !v) {
		if (list !== plState.key) {
			plState.key = list;
			plState.id = list;
			showView("playlist", "Playlist");
			loadPlaylist(list);
		} else showView("playlist", plState.title);
	} else {
		const q = (p.get("q") || "").trim();
		writeFilters(p);
		input.value = q;
		const key = `${q}|${JSON.stringify(readFilters())}|${settings.hideShorts}|${settings.region}`;
		if (q) showView("results", `“${q}” — YouTube search without ads`);
		else showView("home");
		if (key !== state.key) {
			state.key = key;
			state.q = q;
			state.next = null;
			if (q) runSearch();
		}
	}

	// ---- Player / watch party ----
	if (/^[A-Z0-9]{6}$/.test(roomCode)) {
		openRoom(roomCode);
	} else {
		if (room) leaveRoom();
		if (isVideoId(v)) {
			if (current?.id !== v) {
				const card = $(`.card.video[data-id="${CSS.escape(v)}"]`);
				openWatch(v, card?._item || store.get().queue.find((x) => x.id === v) || {});
			}
		} else if (watch.open) {
			closeWatch();
		}
	}
}

window.addEventListener("popstate", syncFromUrl);
syncFromUrl();
