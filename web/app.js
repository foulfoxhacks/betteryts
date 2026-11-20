// BetterYTS by FoulFoxHacks — front page. Plain ES modules, no framework.
// Everything from the API is inserted with textContent / attributes — never innerHTML.

import { bestChapters, toSeconds } from "./chapters.js";
import { currentTheme, initChrome, setTheme, THEMES } from "./chrome.js";
import { $, $$, api, copy, fmtCount, fmtTime, h, isVideoId, minVideo, safeUrl, toast } from "./lib.js";
import { mapLimit, mergeFeed } from "./feed.js";
import { hostKeys, RoomClient } from "./room.js";
import { activeCommunity, applyPalette, BUILTIN, builtinOn, CATEGORIES, categoryOn, community, PERMISSIONS, Sandbox, validateManifest } from "./plugins.js";
import { importSpotify, matchList } from "./spotify.js";
import { authConfig, finishGoogle, finishSpotify, revokeGoogle, spotifyPlaylists, spotifyTracks, startGoogle, startSpotify, youtubeLibrary } from "./accounts.js";
import { buildBackup, cleanLibrary, readBackup } from "./backup.js";
import { qrSvg } from "./qr.js";
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
	// Never show these (one per line or comma-separated). Channels match name, @handle or ID.
	hiddenChannels: "",
	hiddenWords: "",
	dearrow: true,
	dislikes: true,
	autoplay: true,
	captions: false,
	autoNext: true,
	partyName: "",
	region: "",
	// Category switches (Playback, Player, Look, BetterYTS); missing means on.
	categories: {},
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
/** True if a built-in plugin should run: it and its category are both on. */
const on = (id) => builtinOn(settings, id);

// ---------------------------------------------------------------------------------------------
// URL helpers & internal navigation
// ---------------------------------------------------------------------------------------------

const params = () => new URLSearchParams(location.search);

/** Current URL with some params changed (null removes). */
function withParams(patch) {
	const p = params();
	// A start time (?t=) belongs to the video it came with.
	if ("v" in patch && !("t" in patch)) p.delete("t");
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

const VIEWS = { home: ["#home", "#hero"], results: ["#results-view"], library: ["#library-view"], channel: ["#channel-view"], playlist: ["#playlist-view"], link: ["#link-view"] };
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

const state = { key: "", q: "", next: null, loading: false, controller: null, count: 0, blocked: { ads: 0, shorts: 0, shelfItems: 0, operators: 0, hidden: 0 } };

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
		state.blocked = { ads: 0, shorts: 0, shelfItems: 0, operators: 0, hidden: 0 };
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
		state.blocked.operators += data.blocked.operators || 0;
		state.blocked.hidden += data.results.filter(isHidden).length;
		if (!append && data.correctedQuery) {
			const c = $("#corrected");
			c.replaceChildren("Showing results for ", h("b", {}, data.correctedQuery));
			c.hidden = false;
		}
		renderStatus(data.estimatedResults);
		if (!state.count) resultsEl.replaceChildren(h("div", { class: "empty" }, h("p", {}, "No results. Try fewer filters or different words.")));
		if (on("dearrow")) applyDeArrow(data.results);
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
	if (b.hidden) junk.push(`${b.hidden} hidden by you`);
	if (b.operators) parts.push(`${b.operators} filtered by your search operators`);
	statusEl.replaceChildren(parts.join(" · "), junk.length ? h("span", { class: "blocked" }, `🛡 Blocked ${junk.join(", ")}`) : "");
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

const channelHref = (ch) => {
	const ref = ch?.handle || ch?.id || ch?.channelRef;
	return ref ? `/?channel=${encodeURIComponent(ref)}` : null;
};

// ---- Hidden channels and words (Settings › Results; this browser only) ----
const listOf = (s) =>
	String(s || "")
		.split(/[\n,]/)
		.map((x) => x.trim().toLowerCase().replace(/^@/, ""))
		.filter(Boolean);

/** Letters and digits only, like the server's search operators: "@LofiGirl" = "Lofi Girl". */
const compactName = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function isHidden(item) {
	const chans = listOf(settings.hiddenChannels).map(compactName);
	const words = listOf(settings.hiddenWords);
	if (!item || (!chans.length && !words.length)) return false;
	const ch = item.channel || {};
	const ids = [ch.name, ch.handle, ch.id, item.author, item.channelRef];
	if (item.type === "channel") ids.push(item.title, item.handle, item.id);
	if (ids.some((x) => x && chans.includes(compactName(x)))) return true;
	const text = `${item.title || ""} ${ch.name || item.author || ""}`.toLowerCase();
	return words.some((w) => text.includes(w));
}

function renderCard(item) {
	if (isHidden(item)) return null;
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
	// Empty sections say what goes here and offer a next step, instead of one bare line.
	const findSomething = () => h("button", { type: "button", class: "button small primary", onclick: () => { window.scrollTo({ top: 0, behavior: "smooth" }); input.focus(); } }, "Search videos");
	const empty = (msg, icon = "♪", ...actions) => h("div", { class: "empty empty-state" }, h("span", { class: "empty-icon", "aria-hidden": "true" }, icon), h("p", {}, msg), actions.length ? h("div", { class: "empty-actions" }, ...actions) : null);

	if (libTab === "subs") {
		renderSubscriptions(d.subscriptions);
	} else if (libTab === "queue") {
		libBody.replaceChildren(
			h("div", { class: "lib-actions" }, h("button", { type: "button", class: "button small primary", onclick: () => playList(d.queue), disabled: !d.queue.length }, "▶ Play queue"), h("button", { type: "button", class: "button small secondary", onclick: () => store.clearQueue(), disabled: !d.queue.length }, "Clear")),
			d.queue.length
				? h("ol", { class: "row-list" }, d.queue.map((v, i) => rowItem(v, [iconBtn("▶", "Play now", () => (store.removeFromQueue(i), navigate(withParams({ v: v.id }), { watchState: true }))), iconBtn("↑", "Move up", () => store.moveInQueue(i, -1)), iconBtn("↓", "Move down", () => store.moveInQueue(i, 1)), iconBtn("✕", "Remove", () => store.removeFromQueue(i))])))
				: empty("Your queue is empty. Use + on any video to line it up here.", "≡", findSomething()),
		);
	} else if (libTab === "favorites") {
		libBody.replaceChildren(
			h("div", { class: "lib-actions" }, h("button", { type: "button", class: "button small primary", onclick: () => playList(d.favorites), disabled: !d.favorites.length }, "▶ Play all"), h("button", { type: "button", class: "button small secondary", onclick: () => playList(d.favorites, { shuffle: true }), disabled: !d.favorites.length }, "Shuffle"), h("button", { type: "button", class: "button small secondary", onclick: () => copy(shareUrl("Favorites", d.favorites), "Share link"), disabled: !d.favorites.length }, "Copy share link")),
			d.favorites.length ? h("div", { class: "grid" }, d.favorites.map((v) => videoCard(v))) : empty("No favorites yet. Tap ♡ on any video to keep it here.", "♡", findSomething()),
		);
	} else if (libTab === "history") {
		const ago = (t) => {
			const m = Math.round((Date.now() - t) / 60000);
			return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
		};
		libBody.replaceChildren(
			h("div", { class: "lib-actions" }, h("button", { type: "button", class: "button small secondary", onclick: () => confirm("Clear your watch history in this browser?") && store.clearHistory(), disabled: !d.history.length }, "Clear history")),
			d.history.length ? h("ol", { class: "row-list" }, d.history.map((v) => rowItem(v, [iconBtn("+", "Add to queue", () => addToQueue(v)), iconBtn("✕", "Remove from history", () => store.removeHistory(v.id))], ago(v.at)))) : empty("Nothing watched yet. Videos you play show up here (in this browser only).", "↺", findSomething()),
		);
	} else if (libTab === "playlists") {
		const nameInput = h("input", { type: "text", maxlength: 80, placeholder: "New playlist name", "aria-label": "New playlist name" });
		libBody.replaceChildren(
			h("form", { class: "lib-actions", onsubmit: (e) => (e.preventDefault(), nameInput.value.trim() && (store.createPlaylist(nameInput.value.trim()), toast("Playlist created"))) }, nameInput, h("button", { type: "submit", class: "button small primary" }, "Create playlist")),
			youtubeImportPanel(),
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
				: empty("No playlists yet. Save videos to a playlist, or import one below from YouTube or Spotify.", "☰"),
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
	grid.replaceChildren(...items.filter((v) => !isHidden(v)).map((v) => videoCard(v)));
	status.textContent = [
		items.length ? "Newest uploads first (YouTube only gives approximate dates)." : "No recent uploads from these channels.",
		subsFeed.failed ? `${subsFeed.failed} channel${subsFeed.failed === 1 ? "" : "s"} couldn't be loaded.` : "",
	]
		.filter(Boolean)
		.join(" ");
	if (on("dearrow")) applyDeArrow(items);
}

function updateHideButton() {
	const btn = $("#ch-hide");
	const ch = chState.channel;
	btn.hidden = !ch?.id;
	if (!ch?.id) return;
	btn.textContent = isHidden({ type: "channel", id: ch.id, handle: ch.handle, title: ch.title }) ? "Unhide channel" : "Hide channel";
}

$("#ch-hide").addEventListener("click", () => {
	const ch = chState.channel;
	if (!ch?.id) return;
	const keys = [ch.handle, ch.id].filter(Boolean).map((x) => String(x).toLowerCase().replace(/^@/, ""));
	const list = listOf(settings.hiddenChannels);
	const hidden = list.some((x) => keys.includes(x));
	// Both: search results often lack the @handle, but always have the channel ID.
	const next = hidden ? list.filter((x) => !keys.includes(x)) : [...list, ...keys];
	settings.hiddenChannels = next.join("\n");
	saveSettings();
	updateHideButton();
	toast(hidden ? `${ch.title} is shown again` : `${ch.title} is hidden from search, your feed and home. Undo here or in Settings.`);
});

function updateSubButton() {
	updateHideButton();
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

// ---- Import from YouTube (sign in with Google once; the token is revoked right after) ----
let youtubeJob = { running: false, note: "", error: "" };

function youtubeImportPanel() {
	const wrap = h("div", { id: "youtube-import", class: "side-panel spotify-import" });
	fillYoutubePanel(wrap);
	return wrap;
}

function fillYoutubePanel(wrap) {
	const j = youtubeJob;
	wrap.replaceChildren(
		h("h3", {}, "Import from YouTube"),
		h("p", { class: "muted" }, "Sign in with Google to copy your YouTube playlists, liked videos and subscriptions here. Read-only, once: BetterYTS signs out right after and keeps no token. Same import as the BetterYTS Music app."),
		h("button", { type: "button", class: "button small primary", disabled: j.running, onclick: () => startGoogle("import") }, j.running ? "Importing…" : "Sign in with Google"),
		...(j.note ? [h("p", { class: "import-progress" }, j.note)] : []),
		...(j.error ? [h("p", { class: "import-error" }, j.error)] : []),
	);
}

function refreshYoutubePanel() {
	const el = $("#youtube-import");
	if (el) fillYoutubePanel(el);
}

/** Back from Google (/?link=google&code=…&state=…): finish the sign-in and import. */
async function handleGoogleReturn(p) {
	// Drop the code from the address bar straight away.
	history.replaceState(history.state, "", "/?view=library&tab=playlists");
	youtubeJob = { running: true, note: "Signing in…", error: "" };
	let token = null;
	try {
		const done = await finishGoogle(p);
		token = done.token;
		const lib = await youtubeLibrary(token, (note) => {
			youtubeJob.note = note;
			refreshYoutubePanel();
		});
		if (done.purpose?.startsWith("link:")) {
			// Signed in from the VRChat linking page: pick what to send there.
			const code = done.purpose.slice(5);
			linkState.picker = [
				...(lib.liked.length ? [{ name: "Liked videos", items: lib.liked, on: true }] : []),
				...lib.playlists.map((x, i) => ({ name: x.name, items: x.items, on: i < 19 })),
			];
			navigate(`/?view=link&code=${encodeURIComponent(code)}`, { replace: true });
			return;
		}
		// Same checks as a backup import: valid IDs, safe URLs, limits.
		const clean = cleanLibrary({ favorites: lib.liked, subscriptions: lib.subscriptions, playlists: lib.playlists.map((x) => ({ name: x.name, items: x.items })) });
		const sum = store.mergeImport({
			favorites: clean.favorites,
			subscriptions: clean.subscriptions,
			playlists: lib.playlists.map((x, i) => ({ source: x.source, name: clean.playlists[i]?.name ?? x.name, items: clean.playlists[i]?.items ?? [] })),
		});
		youtubeJob = { running: false, note: `Imported ${sum.playlists} new playlist${sum.playlists === 1 ? "" : "s"} (${sum.updated} updated), ${sum.favorites} liked video${sum.favorites === 1 ? "" : "s"} and ${sum.subscriptions} subscription${sum.subscriptions === 1 ? "" : "s"}.`, error: "" };
		toast("YouTube library imported");
	} catch (err) {
		youtubeJob = { running: false, note: "", error: err.message };
	} finally {
		if (token) revokeGoogle(token);
		refreshYoutubePanel();
		renderLibrary?.();
	}
}

// ---- Send music to a VRChat world (/inworld/{service}/auth → /?view=link): src/vrc/links.ts ----
let linkState = { code: "", service: "", checked: false, error: "", note: "", picker: null, sent: null, busy: false, save: false, manage: { key: "", busy: false, error: "", note: "" } };

function openLinkView(code, service) {
	if (code && code !== linkState.code) linkState = { ...linkState, code, checked: false, sent: null, error: "" };
	if (service && !linkState.service) linkState.service = service;
	renderLinkView();
	if (linkState.code && !linkState.checked) checkLinkCode();
}

async function checkLinkCode() {
	linkState.busy = true;
	linkState.error = "";
	renderLinkView();
	try {
		const d = await api("/api/inworld/check", { code: linkState.code });
		linkState = { ...linkState, code: d.code, service: d.service, checked: true };
	} catch (err) {
		linkState.checked = false;
		linkState.error = err.message;
	} finally {
		linkState.busy = false;
		renderLinkView();
	}
}

const MAX_SEND_PLAYLISTS = 20;

async function sendToWorld() {
	const chosen = (linkState.picker || []).filter((p) => p.on).slice(0, MAX_SEND_PLAYLISTS);
	if (!chosen.length) {
		linkState.error = "Pick at least one playlist";
		return renderLinkView();
	}
	linkState.busy = true;
	linkState.error = "";
	renderLinkView();
	try {
		const res = await fetch("/api/inworld/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code: linkState.code,
				service: linkState.service,
				// Only public video IDs, titles and channels; never account details.
				library: { playlists: chosen.map((p) => ({ name: p.name, tracks: p.items.map((v) => ({ id: v.id, title: v.title, channel: v.channel || "" })) })) },
				save: linkState.save === true,
			}),
		});
		const body = await res.json().catch(() => null);
		if (!res.ok || !body?.ok) throw new Error(body?.error?.message || body?.error || `Failed (${res.status})`);
		linkState.sent = body;
		linkState.picker = null;
	} catch (err) {
		linkState.error = err.message;
	} finally {
		linkState.busy = false;
		renderLinkView();
	}
}

function renderLinkView() {
	const root = $("#link-root");
	if (!root) return;
	const s = linkState;
	const step = (n, title, ...kids) => h("section", { class: "link-step side-panel" }, h("h3", {}, h("span", { class: "link-num" }, n), " ", title), ...kids);
	const parts = [
		h("p", { class: "eyebrow" }, "BetterYTS for VRChat"),
		h("h1", { class: "page-title" }, "Send music to a VRChat world"),
		h("p", { class: "muted" }, "In a world with BetterYTS, press Link YouTube or Link Spotify. It shows a code: enter it here, pick playlists, and they appear in the world."),
		h("p", { class: "fine" }, "Sign-ins happen in your browser and no account tokens are ever stored. ", h("a", { href: "/privacy#vrchat" }, "What's kept, and for how long")),
	];
	if (s.sent) {
		parts.push(
			step(
				"✓",
				"Sent",
				h("p", {}, `Sent ${s.sent.playlists} playlist${s.sent.playlists === 1 ? "" : "s"} (${s.sent.tracks} songs). Look at the world: they show up within a few seconds.`),
				h("p", { class: "fine" }, s.sent.saved ? "Saved for your next visit for up to 30 days. The world shows your library key; you can view or delete the library below, or press Unlink in the world." : "Just this visit: nothing is kept once the code expires."), h("button", { type: "button", class: "button small secondary", onclick: () => { linkState = { ...linkState, code: "", checked: false, sent: null }; navigate("/?view=link"); } }, "Link another world")),
		);
		root.replaceChildren(...parts);
		return;
	}
	const input = h("input", { type: "text", class: "room-code-input link-code-input", maxlength: 9, placeholder: "ABCD-1234", "aria-label": "Activation code", value: s.code, autocapitalize: "characters", spellcheck: "false" });
	parts.push(
		step(
			"1",
			"Enter the code from the world",
			h("form", { class: "lib-actions", onsubmit: (e) => (e.preventDefault(), (linkState.code = input.value.trim()), checkLinkCode()) }, input, h("button", { type: "submit", class: "button small primary", disabled: s.busy }, s.checked ? "Checked ✓" : "Check")),
			s.checked ? h("p", { class: "fine" }, `Code ${s.code} is waiting for ${s.service === "spotify" ? "Spotify" : "YouTube"} music. It's good for 10 minutes and works once.`) : null,
		),
	);
	if (s.checked) {
		const lib = store.get();
		const sources = [
			h("button", { type: "button", class: "button small secondary", onclick: () => { linkState.picker = [...(lib.favorites.length ? [{ name: "Favorites", items: lib.favorites, on: true }] : []), ...lib.playlists.map((p, i) => ({ name: p.name, items: p.items, on: i < 19 }))]; renderLinkView(); } }, `This browser's library (${lib.playlists.length} playlists)`),
			h("button", { type: "button", class: "button small primary", onclick: () => startGoogle(`link:${s.code}`) }, "Sign in with Google (YouTube)"),
		];
		const spotifyInput = h("input", { type: "url", placeholder: "https://open.spotify.com/playlist/…", "aria-label": "Spotify playlist link" });
		parts.push(
			step(
				"2",
				"Choose where the music comes from",
				h("div", { class: "link-sources" }, ...sources),
				h(
					"form",
					{
						class: "lib-actions",
						onsubmit: async (e) => {
							e.preventDefault();
							linkState.busy = true;
							linkState.note = "Matching Spotify songs to YouTube…";
							renderLinkView();
							try {
								const r = await importSpotify(spotifyInput.value, (done, total) => {
									linkState.note = `Matching songs… ${done} / ${total}`;
									renderLinkView();
								});
								linkState.picker = [...(linkState.picker || []).filter((p) => p.spotify !== r.name), { name: r.name || "Spotify playlist", items: r.videos, on: true, spotify: r.name }];
								linkState.note = `${r.videos.length} of ${r.total} songs matched${r.unmatched.length ? ` (${r.unmatched.length} not found)` : ""}.`;
							} catch (err) {
								linkState.error = err.message;
								linkState.note = "";
							} finally {
								linkState.busy = false;
								renderLinkView();
							}
						},
					},
					spotifyInput,
					h("button", { type: "submit", class: "button small secondary", disabled: s.busy }, "Add a Spotify playlist"),
				),
				spotifyAccountBlock(`link:${s.code}`),
				authCfg.spotify ? null : h("p", { class: "fine" }, "Spotify: public playlist and album links work now. Signing in to Spotify (private playlists, Liked Songs) needs the site's Spotify app, which isn't set up yet."),
				s.note ? h("p", { class: "import-progress" }, s.note) : null,
			),
		);
	}
	if (s.checked && s.picker) {
		const total = s.picker.filter((p) => p.on).reduce((n, p) => n + Math.min(p.items.length, 200), 0);
		parts.push(
			step(
				"3",
				"Pick what to send",
				h(
					"ul",
					{ class: "link-picker" },
					...s.picker.map((p) =>
						h(
							"li",
							{},
							h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: p.on, onchange: (e) => { p.on = e.target.checked; renderLinkView(); } }), ` ${p.name} `, h("span", { class: "muted" }, `· ${p.items.length} song${p.items.length === 1 ? "" : "s"}`)),
						),
					),
				),
				h("p", { class: "fine" }, `Up to ${MAX_SEND_PLAYLISTS} playlists and 1,000 songs (200 per playlist). Selected: ${total} songs. Only the songs' video IDs, titles and channels are sent; never your account.`),
				h(
					"label",
					{ class: "toggle link-save" },
					h("input", { type: "checkbox", checked: s.save, onchange: (e) => (linkState.save = e.target.checked) }),
					" Save for my next visit",
					h("span", { class: "fine" }, " (kept up to 30 days under a key only the world gets; delete anytime). Off: just this visit, deleted when the code expires."),
				),
				h("button", { type: "button", class: "button primary", disabled: s.busy, onclick: sendToWorld }, s.busy ? "Sending…" : "Send to the world"),
			),
		);
	}
	if (s.error) parts.push(h("p", { class: "import-error", role: "alert" }, s.error));
	parts.push(manageLibraryStep());
	root.replaceChildren(...parts.filter(Boolean));
}

/** See, download or delete a saved world library by the key the world shows. */
function manageLibraryStep() {
	const m = linkState.manage;
	const key = h("input", { type: "text", class: "room-code-input link-code-input", maxlength: 9, placeholder: "1234-5678", "aria-label": "Library key", value: m.key, inputmode: "numeric", spellcheck: "false" });
	const act = async (action) => {
		m.key = key.value.trim();
		if (action === "delete" && !window.confirm("Delete this saved library? Worlds won't be able to load it again. This can't be undone.")) return;
		m.busy = true;
		m.error = "";
		m.note = "";
		renderLinkView();
		try {
			const res = await fetch("/api/inworld/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: m.key, action }) });
			const body = await res.json().catch(() => null);
			if (!res.ok || !body?.ok) throw new Error(body?.error || `Failed (${res.status})`);
			if (action === "delete") m.note = `Deleted library ${body.deleted}.`;
			else {
				const blob = new Blob([JSON.stringify(body, null, 1)], { type: "application/json" });
				const a = h("a", { href: URL.createObjectURL(blob), download: `betteryts-world-library-${body.key}.json` });
				document.body.append(a);
				a.click();
				a.remove();
				const n = body.library.playlists.reduce((t, p) => t + p.tracks.length, 0);
				m.note = `Library ${body.key}: ${body.library.playlists.length} playlists, ${n} songs, saved ${body.savedAt.slice(0, 10)}, deleted automatically ${body.expiresAt.slice(0, 10)}. Downloaded a copy.`;
			}
		} catch (err) {
			m.error = err.message;
		} finally {
			m.busy = false;
			renderLinkView();
		}
	};
	return h(
		"section",
		{ class: "link-step side-panel", id: "manage" },
		h("h3", {}, "Manage a saved library"),
		h("p", { class: "fine" }, "A world that saved your playlists shows your library key (it changes each visit). Enter it to download what's stored or delete it. In the world, Unlink deletes it too."),
		h("div", { class: "lib-actions" }, key, h("button", { type: "button", class: "button small secondary", disabled: m.busy, onclick: () => act("view") }, "View & download"), h("button", { type: "button", class: "button small secondary", disabled: m.busy, onclick: () => act("delete") }, "Delete")),
		m.note ? h("p", { class: "import-progress" }, m.note) : null,
		m.error ? h("p", { class: "import-error", role: "alert" }, m.error) : null,
	);
}

// ---- Sign in with Spotify: pick playlists (and Liked Songs), match them, import or send ----
let spotifyAccount = null; // { token, lists, picked:Set, purpose, running, note, error }
let authCfg = {};
authConfig().then((c) => {
	authCfg = c || {};
	refreshSpotifyPanel();
	if (currentView === "link") renderLinkView();
});

async function handleSpotifyReturn(p) {
	const isLink = () => spotifyAccount?.purpose?.startsWith("link:");
	history.replaceState(history.state, "", "/?view=library&tab=playlists");
	spotifyAccount = { token: null, lists: [], picked: new Set(), purpose: "import", running: true, note: "Signing in to Spotify…", error: "" };
	try {
		const done = await finishSpotify(p);
		spotifyAccount.token = done.token;
		spotifyAccount.purpose = done.purpose;
		spotifyAccount.note = "Reading your playlists…";
		refreshSpotifyChooser();
		spotifyAccount.lists = await spotifyPlaylists(done.token);
		spotifyAccount.picked = new Set(spotifyAccount.lists.slice(0, 5).map((l) => l.id));
		spotifyAccount.note = "";
	} catch (err) {
		spotifyAccount.error = err.message;
	} finally {
		spotifyAccount.running = false;
		if (isLink()) navigate(`/?view=link&code=${encodeURIComponent(spotifyAccount.purpose.slice(5))}`, { replace: true });
		else refreshSpotifyChooser();
	}
}

function refreshSpotifyChooser() {
	refreshSpotifyPanel();
	if (currentView === "link") renderLinkView();
}

/** Matches the picked playlists and hands them on: into the library, or to the linking page. */
async function importPickedSpotify() {
	const a = spotifyAccount;
	const lists = a.lists.filter((l) => a.picked.has(l.id));
	if (!lists.length) return;
	a.running = true;
	a.error = "";
	const out = [];
	try {
		for (const [i, l] of lists.entries()) {
			a.note = `Reading “${l.name}” (${i + 1} of ${lists.length})…`;
			refreshSpotifyChooser();
			const list = await spotifyTracks(a.token, l);
			const r = await matchList(list, (done, total) => {
				a.note = `Matching “${l.name}”: ${done} / ${total}`;
				refreshSpotifyChooser();
			});
			out.push({ source: `spotify:${l.id}`, name: l.name, items: r.videos });
		}
		if (a.purpose.startsWith("link:")) {
			linkState.picker = [...(linkState.picker || []), ...out.map((x) => ({ name: x.name, items: x.items, on: true }))];
			a.note = `${out.reduce((n, x) => n + x.items.length, 0)} songs matched. Pick what to send below.`;
		} else {
			const sum = store.mergeImport({ playlists: out });
			a.note = `Imported ${sum.playlists} new playlist${sum.playlists === 1 ? "" : "s"} (${sum.updated} updated).`;
			toast("Spotify playlists imported");
		}
	} catch (err) {
		a.error = err.message;
	} finally {
		a.running = false;
		refreshSpotifyChooser();
	}
}

/** The signed-in chooser (or a Sign in button when Spotify sign-in is set up). */
function spotifyAccountBlock(purpose) {
	const a = spotifyAccount;
	if (!a || !a.token) {
		if (!authCfg.spotify) return null;
		return h(
			"div",
			{ class: "link-sources" },
			h("button", { type: "button", class: "button small primary", onclick: () => startSpotify(purpose) }, "Sign in with Spotify"),
			a?.error ? h("p", { class: "import-error" }, a.error) : null,
			a?.note ? h("p", { class: "import-progress" }, a.note) : null,
		);
	}
	return h(
		"div",
		{ class: "spotify-chooser" },
		h("p", { class: "fine" }, "Pick playlists to bring over. Each song is matched to its YouTube version."),
		h(
			"ul",
			{ class: "link-picker" },
			...a.lists.map((l) =>
				h(
					"li",
					{},
					h(
						"label",
						{ class: "toggle" },
						h("input", { type: "checkbox", checked: a.picked.has(l.id), disabled: a.running, onchange: (e) => (e.target.checked ? a.picked.add(l.id) : a.picked.delete(l.id)) }),
						` ${l.name} `,
						h("span", { class: "muted" }, `· ${l.count} song${l.count === 1 ? "" : "s"}`),
					),
				),
			),
		),
		h("button", { type: "button", class: "button small primary", disabled: a.running, onclick: importPickedSpotify }, a.running ? "Working…" : "Match the picked playlists"),
		a.note ? h("p", { class: "import-progress" }, a.note) : null,
		a.error ? h("p", { class: "import-error" }, a.error) : null,
	);
}

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
		spotifyAccountBlock("import"),
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
		if (on("dearrow")) applyDeArrow(d.results);
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
		if (on("dearrow")) applyDeArrow(d.results);
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
	for (const id of ["#votes", "#segments", "#desc-wrap", "#full-label", "#jump-highlight", "#watch-original", "#chapters", "#save-menu", "#lyrics", "#transcript"]) $(id).hidden = true;
	resetTranscript();
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
	const title = on("dearrow") && d.dearrow?.title ? d.dearrow.title : d.title;
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

	if (on("dislikes") && d.votes && d.votes.likes + d.votes.dislikes > 0) {
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
	sendNowPlaying(true);

	current.segments = on("sponsorblock") ? d.sponsorblock || [] : [];
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
	if (room) roomDriftTick(t);
	updateActiveChapter(t);
	updateActiveLyric(t);
	updateActiveTranscript(t);
	sendNowPlaying(false);

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

// ---- Transcript: the video's captions, searchable, click a line to jump (loaded on demand) ----
let transcript = { id: null, lines: [], active: -1 };

function resetTranscript() {
	transcript = { id: null, lines: [], active: -1 };
	$("#transcript-list").replaceChildren();
	$("#transcript-search").value = "";
	$("#transcript-source").textContent = "";
	$("#show-transcript").setAttribute("aria-expanded", "false");
}

async function loadTranscript(lang) {
	if (!current) return;
	const id = current.id;
	const status = $("#transcript-status");
	status.textContent = "Loading the transcript…";
	status.hidden = false;
	$("#transcript-list").replaceChildren();
	try {
		const d = await api(`/api/transcript/${encodeURIComponent(id)}`, lang ? { lang } : {});
		if (current?.id !== id) return;
		transcript = { id, lines: d.lines || [], active: -1 };
		const sel = $("#transcript-lang");
		sel.replaceChildren(...(d.languages || []).map((l) => h("option", { value: l.auto ? `${l.code}:asr` : l.code, selected: l.code === d.language?.code && l.auto === d.language?.auto }, l.name)));
		sel.hidden = (d.languages || []).length < 2;
		$("#transcript-source").textContent = d.language ? `· ${d.language.name}` : "";
		if (!transcript.lines.length) {
			status.textContent = "This video has no captions.";
			return;
		}
		status.hidden = true;
		$("#transcript-list").replaceChildren(
			...transcript.lines.map((l, i) => h("li", {}, h("button", { type: "button", class: "lyric transcript-line", "data-i": i, onclick: () => seek(l.start) }, h("span", { class: "transcript-time" }, fmtTime(l.start)), " ", l.text))),
		);
		filterTranscript();
	} catch (err) {
		if (current?.id === id) status.textContent = `Couldn't load the transcript: ${err.message}`;
	}
}

function filterTranscript() {
	const q = $("#transcript-search").value.trim().toLowerCase();
	let shown = 0;
	for (const b of $$(".transcript-line", $("#transcript-list"))) {
		const hit = !q || b.textContent.toLowerCase().includes(q);
		b.parentElement.hidden = !hit;
		if (hit) shown++;
	}
	const status = $("#transcript-status");
	if (q && transcript.lines.length) {
		status.textContent = shown ? `${shown} line${shown === 1 ? "" : "s"} match` : "No matches";
		status.hidden = false;
	} else if (transcript.lines.length) status.hidden = true;
}

function updateActiveTranscript(t) {
	if (!transcript.lines.length || $("#transcript").hidden) return;
	let i = -1;
	for (let k = 0; k < transcript.lines.length && transcript.lines[k].start <= t + 0.2; k++) i = k;
	if (i === transcript.active) return;
	transcript.active = i;
	const list = $("#transcript-list");
	for (const b of $$(".transcript-line.active", list)) b.classList.remove("active");
	const el = list.querySelector(`.transcript-line[data-i="${i}"]`);
	if (el) {
		el.classList.add("active");
		// Follow along only while not searching (the list is filtered then).
		if (!$("#transcript-search").value) list.scrollTop = el.offsetTop - list.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
	}
}

$("#show-transcript").addEventListener("click", () => {
	const panel = $("#transcript");
	const open = panel.hidden;
	panel.hidden = !open;
	$("#show-transcript").setAttribute("aria-expanded", String(open));
	if (open && current && transcript.id !== current.id) loadTranscript();
	if (open) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
$("#transcript-search").addEventListener("input", filterTranscript);
$("#transcript-lang").addEventListener("change", (e) => loadTranscript(e.target.value));

// ---- Backup: export / import everything this browser keeps ----
$("#backup-export").addEventListener("click", async () => {
	let version = "";
	try {
		version = (await api("/api/health")).version || "";
	} catch {
		/* offline: export anyway */
	}
	const backup = buildBackup({ settings, library: store.get(), plugins: community.all(), version });
	const blob = new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" });
	const a = h("a", { href: URL.createObjectURL(blob), download: `betteryts-backup-${new Date().toISOString().slice(0, 10)}.json` });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
	toast("Backup saved");
});

$("#backup-file").addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	e.target.value = "";
	const err = $("#backup-error");
	err.hidden = true;
	if (!file) return;
	try {
		const b = readBackup(await file.text(), DEFAULTS);
		const c = b.counts;
		const what = `${c.favorites} favorites, ${c.history} history, ${c.playlists} playlists, ${c.subscriptions} subscriptions, ${c.queue} in the queue, ${b.plugins.length} community plugins`;
		if (!window.confirm(`Replace what's in this browser with this backup${b.exportedAt ? ` from ${b.exportedAt.slice(0, 10)}` : ""}?\n\n${what}\n\nYour current library and settings here will be overwritten.`)) return;
		Object.assign(settings, b.settings);
		saveSettings();
		store.replaceAll(b.library);
		community.save(b.plugins);
		toast("Backup restored");
		setTimeout(() => location.reload(), 600);
	} catch (ex) {
		err.textContent = ex.message;
		err.hidden = false;
	}
});

// ---- Home: "Try" chips under the search ----
for (const chip of $$(".hero-chip[data-try]")) {
	chip.addEventListener("click", () => {
		input.value = chip.dataset.try;
		form.requestSubmit();
	});
}

// ---- Send to phone / VR: a QR code, a short link to type in VRChat, or a watch party ----
function sendDialog() {
	let dlg = $("#send-dlg");
	if (dlg) return dlg;
	dlg = h("dialog", { id: "send-dlg", class: "send-dlg", "aria-label": "Send to phone or VR" });
	dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
	document.body.append(dlg);
	return dlg;
}

function openSendTo() {
	if (!current) return;
	const id = current.id;
	const title = current.video?.title || id;
	let t = 0;
	try {
		t = Math.floor(player?.getCurrentTime?.() || 0);
	} catch {
		/* player not ready */
	}
	const here = `${location.origin}/?v=${id}${t > 5 ? `&t=${t}` : ""}`;
	const vr = `${location.host}/v/${id}`;
	const panel = (heading, ...kids) => h("section", { class: "send-panel" }, h("h3", {}, heading), ...kids);
	const code = (text, label) => h("div", { class: "send-code" }, h("code", {}, text), h("button", { type: "button", class: "button tiny secondary", onclick: () => copy(text.startsWith("http") ? text : `https://${text}`, label) }, "Copy"));

	const parts = [
		h("header", { class: "send-head" }, h("h2", {}, "Send to phone or VR"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => sendDialog().close() }, "✕")),
		h("p", { class: "fine send-title" }, title),
		panel("Phone or another computer", h("div", { class: "send-qr" }, qrSvg(here, { label: `QR code: open this video${t > 5 ? ` at ${fmtTime(t)}` : ""}` })), h("p", { class: "fine" }, `Scan to open it on BetterYTS${t > 5 ? ` at ${fmtTime(t)}` : ""}.`), code(here, "Link")),
		panel("VRChat", h("p", { class: "fine" }, "Type or paste into any in-world video player:"), code(vr, "VRChat link")),
	];
	if (room) {
		const invite = `${location.origin}/?room=${room.code}`;
		const vrRoom = `${location.host}/room/${room.code}`;
		parts.push(
			panel(
				`Watch party ${room.code}`,
				h("div", { class: "send-qr" }, qrSvg(invite, { label: `QR code: join room ${room.code}` })),
				h("p", { class: "fine" }, "Scan to join. In VRChat, put this in a video player: it plays whatever the room plays."),
				code(vrRoom, "Room VRChat link"),
			),
		);
	} else {
		parts.push(
			panel(
				"Keep VR in sync",
				h("p", { class: "fine" }, "Start a watch party, then put its short link in an in-world player once: everything you play here follows in VR."),
				h("button", { type: "button", class: "button small primary", onclick: () => { sendDialog().close(); startParty(); } }, "Start a watch party"),
			),
		);
	}
	const dlg = sendDialog();
	dlg.replaceChildren(...parts);
	if (!dlg.open) dlg.showModal();
}
$("#send-to").addEventListener("click", openSendTo);

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
	clearTimeout(startTimer);
	if (!current || current.id !== s.video.id) {
		endNudge();
		suppressUntil = performance.now() + 2500;
		openWatch(s.video.id, { id: s.video.id, title: s.video.title }, { start: room.positionOf(s) });
		return;
	}
	if (!player?.getCurrentTime) return;
	const YTS = window.YT.PlayerState;
	const t = player.getCurrentTime();
	const playing = player.getPlayerState?.() === YTS.PLAYING || player.getPlayerState?.() === YTS.BUFFERING;
	const hold = () => {
		suppressUntil = performance.now() + 1200;
	};

	// Sync v2: the server schedules starts slightly in the future (state.at) so everyone starts
	// together. If we're stopped, cue the position now and press play at exactly that moment.
	const wait = room.msUntil(s);
	if (s.playing && !playing && wait > 30) {
		if (force || Math.abs(t - s.position) > 0.3) {
			hold();
			player.seekTo(s.position, true);
			lastTick = { t: s.position, wall: performance.now() };
		}
		startTimer = setTimeout(() => {
			if (roomState !== s || !player) return;
			hold();
			player.playVideo();
		}, wait);
		return;
	}

	// Where the room's timeline is right now (before a scheduled start that's slightly behind
	// s.position, which keeps an already-playing player continuous).
	const target = s.playing ? Math.max(0, s.position + (room.serverNow() - s.at) / 1000) : s.position;
	if (!s.playing) endNudge();
	if (force || Math.abs(t - target) > 1) {
		endNudge();
		hold();
		player.seekTo(target, true);
		lastTick = { t: target, wall: performance.now() };
	}
	if (s.playing && !playing) {
		hold();
		player.playVideo();
	} else if (!s.playing && playing) {
		hold();
		player.pauseVideo();
	}
}

// ---------- Watch party: drift correction ----------

let startTimer = null;
let nudge = { dir: 0 };

/** Back to normal speed after a catch-up. */
function endNudge() {
	if (!nudge.dir) return;
	nudge.dir = 0;
	try {
		player?.setPlaybackRate?.(1);
	} catch {
		/* player gone */
	}
}

/**
 * Runs every player tick in a room. Small drift (0.25–2 s) is fixed by briefly playing at 1.25×
 * or 0.75× until we're within 80 ms, which is invisible compared to a seek (seeks re-buffer and
 * cause new drift). Bigger gaps get a seek.
 */
function roomDriftTick(t) {
	const s = roomState;
	if (!room || !s?.playing || !s.video || current?.id !== s.video.id || room.msUntil(s) > 0) return endNudge();
	if (player?.getPlayerState?.() !== window.YT?.PlayerState?.PLAYING) return;
	const drift = t - room.positionOf(s); // > 0: we're ahead
	const a = Math.abs(drift);
	if (a > 2) {
		endNudge();
		suppressUntil = performance.now() + 1200;
		const target = room.positionOf(s);
		player.seekTo(target, true);
		lastTick = { t: target, wall: performance.now() };
		return;
	}
	const dir = drift < 0 ? 1 : -1; // speed up when behind
	if (nudge.dir && (a < 0.08 || dir !== nudge.dir)) endNudge();
	else if (!nudge.dir && a > 0.25) {
		nudge.dir = dir;
		player.setPlaybackRate?.(dir > 0 ? 1.25 : 0.75);
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
	clearTimeout(startTimer);
	endNudge();
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
	if (el.dataset.category) {
		settings.categories = { ...settings.categories, [el.dataset.category]: el.checked };
		el.closest(".plugin-group")?.setAttribute("data-off", String(!el.checked));
	}
	if (el.dataset.community) community.setEnabled(el.dataset.community, el.checked);
	saveSettings();
	if (el.dataset.setting === "partyName") room?.setName(settings.partyName || "Guest");
	applyPlugins();
	if (["hideShorts", "dearrow", "region", "hiddenChannels", "hiddenWords"].includes(el.dataset.setting) && state.q && currentView === "results") runSearch();
});
$("#open-settings").addEventListener("click", () => {
	renderPluginGroups();
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
		if (el) el.hidden = !on("vrchat");
	}
	$("#sleep-wrap").hidden = !on("sleep");
	if (!on("sleep")) cancelSleep();
	if (!on("lyrics")) $("#lyrics").hidden = true;
	startCommunity();
}

// ---- Plugin settings: categories with whole-category switches, then community plugins ----
function renderPluginGroups() {
	const sb = $("#sb-settings");
	const installed = community.all();
	const row = (attrs, name, description, extra) =>
		h("label", { class: "plugin" }, h("input", { type: "checkbox", ...attrs }), h("span", {}, h("b", {}, name), h("small", {}, description), extra));
	$("#plugin-groups").replaceChildren(
		...CATEGORIES.map((c) => {
			const catOn = categoryOn(settings, c.id);
			const items = [
				...BUILTIN.filter((p) => p.category === c.id).map((p) => {
					const r = row({ "data-setting": p.id }, p.name, p.description);
					return p.id === "sponsorblock" ? [r, sb] : [r];
				}).flat(),
				...installed.filter((p) => p.category === c.id).map((p) =>
					h(
						"div",
						{ class: "plugin-community" },
						row(
							{ "data-community": p.id, checked: p.enabled },
							p.name,
							p.description || "Community plugin",
							h("small", { class: "plugin-perms" }, `Community${p.author ? ` · by ${p.author}` : ""}${p.version ? ` · v${p.version}` : ""} · can: ${p.permissions.map((x) => PERMISSIONS[x]).join("; ")}`),
						),
						h("button", { type: "button", class: "button small secondary", "data-remove-plugin": p.id }, "Remove"),
					),
				),
			];
			return h(
				"section",
				{ class: "plugin-group", "data-off": String(!catOn) },
				h(
					"label",
					{ class: "plugin-category" },
					h("input", { type: "checkbox", "data-category": c.id, checked: catOn }),
					h("span", {}, h("b", {}, c.name), h("small", {}, c.description)),
				),
				h("div", { class: "plugin-items" }, items),
			);
		}),
	);
	syncSettingsForm();
}

$("#community-install").addEventListener("click", () => {
	const err = $("#community-error");
	err.hidden = true;
	try {
		const text = $("#community-manifest").value.trim();
		if (!text) throw new Error("Paste a manifest first");
		// Validated before asking, so the prompt lists exactly what will be granted.
		const v = validateManifest(text);
		const can = v.permissions.map((x) => `• ${PERMISSIONS[x]}`).join("\n");
		const ok = window.confirm(`Install "${v.name}" (${v.category})?\n\nIt will be able to:\n${can}\n\nIt can't use the network, your cookies or this page.`);
		if (!ok) return;
		const p = community.install(text);
		$("#community-manifest").value = "";
		toast(`Installed ${p.name}`);
		renderPluginGroups();
		applyPlugins();
	} catch (e) {
		err.textContent = e.message;
		err.hidden = false;
	}
});

$("#plugin-groups").addEventListener("click", (e) => {
	const btn = e.target.closest("[data-remove-plugin]");
	if (!btn) return;
	community.remove(btn.dataset.removePlugin);
	renderPluginGroups();
	applyPlugins();
});

// ---- Community plugins at runtime ----
let sandboxes = [];
let lastNowPlayingAt = 0;

function startCommunity() {
	const active = activeCommunity(settings);
	applyPalette(active);
	const want = active.filter((p) => p.code);
	const key = want.map((p) => p.id + ":" + p.code.length + ":" + p.version).join("|");
	if (startCommunity.key === key) return;
	startCommunity.key = key;
	for (const s of sandboxes) s.destroy();
	const panels = $("#plugin-panels");
	panels.replaceChildren();
	sandboxes = want.map((p) => {
		const box = h("div", { class: "side-panel plugin-panel", hidden: true }, h("h3", {}, p.name, " ", h("span", { class: "muted" }, "· community plugin")), h("p", { class: "plugin-panel-text" }));
		panels.append(box);
		return new Sandbox(p, {
			onPanel: (text) => {
				box.querySelector(".plugin-panel-text").textContent = text; // text only, never HTML
				box.hidden = !text;
			},
			onError: (text) => console.warn(`[plugin ${p.id}]`, text),
		});
	});
	sendNowPlaying(true);
}

/** What Player plugins with "nowPlaying" get: nothing about the user, only the video. */
function sendNowPlaying(force) {
	if (!sandboxes.length || !current) return;
	const now = performance.now();
	if (!force && now - lastNowPlayingAt < 5000) return;
	lastNowPlayingAt = now;
	let position = 0;
	let playing = false;
	try {
		position = player?.getCurrentTime?.() || 0;
		playing = player?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
	} catch {
		/* player not ready */
	}
	const v = current.video || {};
	const data = { id: current.id, title: v.title || "", channel: v.author || "", position, duration: current.duration || 0, playing };
	for (const s of sandboxes) s.nowPlaying(data);
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
			h("div", { class: "shelf-row" }, items.filter((v) => !isHidden(v)).map((v) => videoCard(v))),
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
	// Back from Google sign-in: finish it (this rewrites the URL), then show the library.
	if (p.get("link") === "google" && (p.get("code") || p.get("error"))) {
		handleGoogleReturn(p);
		return syncFromUrl();
	}
	if (p.get("link") === "spotify" && (p.get("code") || p.get("error"))) {
		handleSpotifyReturn(p);
		return syncFromUrl();
	}
	const view = p.get("view");
	const channelRef = p.get("channel");
	const list = p.get("list");
	const roomCode = (p.get("room") || "").toUpperCase();
	const v = p.get("v");

	// ---- Page behind the player ----
	if (view === "link") {
		showView("link", "Send music to VRChat");
		openLinkView(p.get("code"), p.get("service"));
	} else if (view === "library") {
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
				// ?t= (seconds) starts there: QR codes from "Send to phone" carry it.
				const start = Math.max(0, Math.floor(Number(p.get("t")) || 0));
				openWatch(v, card?._item || store.get().queue.find((x) => x.id === v) || {}, { start });
			}
		} else if (watch.open) {
			closeWatch();
		}
	}
}

window.addEventListener("popstate", syncFromUrl);
syncFromUrl();
