// BetterYTS front page. Plain ES modules, no framework.
// Everything from the API is inserted with textContent / attributes — never innerHTML.

import { initChrome } from "./chrome.js";

initChrome();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
		else if (k === "style") el.style.cssText = v;
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const child of children.flat()) {
		if (child == null || child === false) continue;
		el.append(child instanceof Node ? child : String(child));
	}
	return el;
}

const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

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
	hideShorts: true,
	dearrow: true,
	dislikes: true,
	autoplay: true,
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
// Helpers
// ---------------------------------------------------------------------------------------------

function fmtTime(sec) {
	sec = Math.max(0, Math.round(sec));
	const hh = Math.floor(sec / 3600);
	const mm = Math.floor((sec % 3600) / 60);
	const ss = String(sec % 60).padStart(2, "0");
	return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}
const nf = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fmtCount = (n) => (typeof n === "number" ? nf.format(n) : "");

let toastTimer;
function toast(message, action) {
	const el = $("#toast");
	el.replaceChildren(h("span", {}, message));
	if (action) el.append(h("button", { type: "button", class: "toast-btn", onclick: () => (action.run(), (el.hidden = true)) }, action.label));
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 2500);
}

async function copy(textValue, what = "Link") {
	try {
		await navigator.clipboard.writeText(textValue);
	} catch {
		const ta = h("textarea", { style: "position:fixed;opacity:0" }, textValue);
		document.body.append(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
	}
	toast(`${what} copied`);
}

async function api(path, params = {}, signal) {
	const u = new URL(path, location.origin);
	for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, v);
	const res = await fetch(u, { signal });
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(body?.error?.message || `Request failed (${res.status})`);
	return body;
}

// ---------------------------------------------------------------------------------------------
// Search state + URL sync
// ---------------------------------------------------------------------------------------------

const form = $("#search-form");
const input = $("#q");
const filtersEl = $("#filters");
const resultsEl = $("#results");
const statusEl = $("#status");

const state = { key: "", q: "", next: null, loading: false, controller: null, count: 0, blocked: { ads: 0, shorts: 0, shelfItems: 0 } };

function readFilters() {
	const f = {};
	for (const sel of $$("select", filtersEl)) if (sel.value && !(sel.name === "type" && sel.value === "all") && !(sel.name === "sort" && sel.value === "relevance")) f[sel.name] = sel.value;
	const feats = $$(".chip[aria-pressed=true]", filtersEl).map((c) => c.dataset.feature);
	if (feats.length) f.features = feats.join(",");
	return f;
}

function writeFilters(params) {
	for (const sel of $$("select", filtersEl)) sel.value = params.get(sel.name) || sel.options[0].value;
	const feats = (params.get("features") || "").split(",");
	for (const chip of $$(".chip", filtersEl)) chip.setAttribute("aria-pressed", String(feats.includes(chip.dataset.feature)));
}

function urlFor(q, filters, extra = {}) {
	const p = new URLSearchParams();
	if (q) p.set("q", q);
	for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) p.set(k, v);
	const s = p.toString();
	return s ? `/?${s}` : "/";
}

function showHome(on) {
	$("#home").hidden = !on;
	$("#hero").hidden = !on;
	$("#results-view").hidden = on;
	// One search form: big in the hero on the home page, compact in the navbar on results.
	const slot = on ? $("#hero-search-slot") : $("#nav-search-slot");
	if (form.parentElement !== slot) {
		const hadFocus = document.activeElement === input;
		slot.append(form);
		if (hadFocus) input.focus();
	}
	document.title = on ? "BetterYTS — Ad-free YouTube Search for the Web & VRChat" : `“${state.q}” — YouTube search without ads · BetterYTS`;
}

async function runSearch({ append = false } = {}) {
	if (!state.q) return showHome(true);
	if (append && (!state.next || state.loading)) return;
	showHome(false);

	state.controller?.abort();
	const controller = new AbortController();
	state.controller = controller;
	state.loading = true;
	$("#load-more").hidden = true;

	if (!append) {
		state.count = 0;
		state.blocked = { ads: 0, shorts: 0, shelfItems: 0 };
		resultsEl.replaceChildren(...Array.from({ length: 8 }, () => h("div", { class: "card skeleton" }, h("div", { class: "thumb" }), h("div", { class: "line" }), h("div", { class: "line short" }))));
		statusEl.textContent = "Searching…";
		$("#corrected").hidden = true;
	}

	const params = {
		q: state.q,
		...readFilters(),
		shorts: settings.hideShorts ? "0" : "1",
		gl: settings.region,
		page: append ? state.next : "",
	};

	let ok = false;
	try {
		const data = await api("/api/search", params, controller.signal);
		if (controller !== state.controller) return;
		if (!append) resultsEl.replaceChildren();
		const cards = data.results.map(renderCard).filter(Boolean);
		resultsEl.append(...cards);
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
		if (!state.count) {
			resultsEl.replaceChildren(h("div", { class: "empty" }, h("p", {}, "No results. Try fewer filters or different words.")));
		}
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
			// Short pages (e.g. after stripping Shorts shelves) leave the sentinel on screen,
			// which the observer won't re-report — keep filling until it's pushed below the fold.
			if (ok) {
				requestAnimationFrame(() => {
					if (state.next && !state.loading && $("#sentinel").getBoundingClientRect().top < innerHeight + 800) runSearch({ append: true });
				});
			}
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
// Result cards
// ---------------------------------------------------------------------------------------------

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
	const href = `/?v=${encodeURIComponent(v.id)}`;
	const ch = v.channel;
	const card = h(
		"article",
		{ class: "card video", "data-id": v.id },
		h(
			"a",
			{ class: "thumb", href, onclick: (e) => openFromCard(e, v), "aria-label": v.title },
			h("img", { src: v.thumbnail, alt: `Thumbnail: ${v.title}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }),
			badge,
		),
		h(
			"div",
			{ class: "meta" },
			ch?.avatar ? h("img", { class: "avatar", src: safeUrl(ch.avatar), alt: `${ch.name} channel avatar`, loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "avatar ph" }),
			h(
				"div",
				{ class: "meta-text" },
				h("a", { class: "title", href, onclick: (e) => openFromCard(e, v), title: v.title }, v.title),
				ch ? h("a", { class: "channel", href: safeUrl(ch.url) ?? "#", target: "_blank", rel: "noopener" }, ch.name, ch.verified ? h("span", { class: "check", title: "Verified" }, " ✓") : "") : null,
				h("span", { class: "sub" }, [v.views, v.published].filter(Boolean).join(" · ")),
			),
		),
	);
	card._item = v;
	return card;
}

function channelCard(c) {
	return h(
		"article",
		{ class: "card channel" },
		h("a", { class: "channel-avatar", href: safeUrl(c.url), target: "_blank", rel: "noopener" }, c.thumbnail ? h("img", { src: safeUrl(c.thumbnail), alt: `${c.title} channel avatar`, loading: "lazy", referrerpolicy: "no-referrer" }) : ""),
		h(
			"div",
			{ class: "meta-text" },
			h("a", { class: "title", href: safeUrl(c.url), target: "_blank", rel: "noopener" }, c.title, c.verified ? h("span", { class: "check" }, " ✓") : ""),
			h("span", { class: "sub" }, [c.handle, c.subscribers].filter(Boolean).join(" · ")),
			c.description ? h("p", { class: "desc-snippet" }, c.description) : null,
			h("span", { class: "kind" }, "Channel"),
		),
	);
}

function playlistCard(p) {
	const href = p.firstVideoId ? `/?v=${encodeURIComponent(p.firstVideoId)}&list=${encodeURIComponent(p.id)}` : safeUrl(p.url);
	return h(
		"article",
		{ class: "card playlist" },
		h(
			"a",
			{ class: "thumb stack", href, onclick: (e) => p.firstVideoId && openFromCard(e, { id: p.firstVideoId, title: p.title, list: p.id }) },
			p.thumbnail ? h("img", { src: safeUrl(p.thumbnail), alt: `Playlist thumbnail: ${p.title}`, loading: "lazy", referrerpolicy: "no-referrer" }) : "",
			h("span", { class: "badge list" }, p.type === "mix" ? "MIX" : p.videoCount || "PLAYLIST"),
		),
		h(
			"div",
			{ class: "meta" },
			h(
				"div",
				{ class: "meta-text" },
				h("a", { class: "title", href, onclick: (e) => p.firstVideoId && openFromCard(e, { id: p.firstVideoId, title: p.title, list: p.id }) }, p.title),
				p.channel ? h("span", { class: "channel" }, p.channel.name) : null,
				h("span", { class: "kind" }, p.type === "mix" ? "Mix" : "Playlist"),
			),
		),
	);
}

async function applyDeArrow(items) {
	const ids = items.filter((i) => i.type === "video").map((i) => i.id);
	for (let i = 0; i < ids.length; i += 30) {
		const chunk = ids.slice(i, i + 30);
		let brands;
		try {
			brands = await api("/api/branding", { ids: chunk.join(",") });
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

// ---------------------------------------------------------------------------------------------
// Suggestions
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
			sugg.replaceChildren(
				...list.map((s, i) =>
					h("li", { id: `sugg-${i}`, role: "option", "aria-selected": "false", onmousedown: (e) => (e.preventDefault(), submitQuery(s)) }, s),
				),
			);
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
	} else if (e.key === "Escape") {
		closeSuggestions();
	}
});
input.addEventListener("blur", () => setTimeout(closeSuggestions, 100));

function submitQuery(q) {
	input.value = q;
	closeSuggestions();
	const clean = q.trim();
	if (!clean) return;
	history.pushState({}, "", urlFor(clean, readFilters()));
	syncFromUrl();
	input.blur();
}

form.addEventListener("submit", (e) => {
	e.preventDefault();
	submitQuery(input.value);
});

// Filter changes re-run the search
filtersEl.addEventListener("change", () => state.q && submitQuery(state.q));
filtersEl.addEventListener("click", (e) => {
	const chip = e.target.closest(".chip");
	if (!chip) return;
	chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"));
	if (state.q) submitQuery(state.q);
});

// Infinite scroll
new IntersectionObserver((entries) => {
	if (entries.some((e) => e.isIntersecting) && state.next && !state.loading) runSearch({ append: true });
}, { rootMargin: "800px" }).observe($("#sentinel"));
$("#load-more").addEventListener("click", () => runSearch({ append: true }));

// ---------------------------------------------------------------------------------------------
// Watch dialog: YouTube IFrame API on youtube-nocookie + SponsorBlock auto-skip
// ---------------------------------------------------------------------------------------------

const watch = $("#watch");
let ytReady;
let player = null;
let tick = null;
let watchSeq = 0;
let current = null; // { id, segments, skipped:Set, muted:boolean }

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
	const extra = item.list ? { v: item.id, list: item.list } : { v: item.id };
	history.pushState({ watch: true }, "", urlFor(state.q, readFilters(), extra));
	openWatch(item.id, item);
}

function resetWatchUi() {
	for (const id of ["#votes", "#segments", "#desc-wrap", "#full-label", "#jump-highlight", "#watch-original"]) $(id).hidden = true;
	$("#seg-bar").replaceChildren();
	$("#watch-stats").textContent = "";
	$("#watch-channel").textContent = "";
	$("#watch-channel").removeAttribute("href");
}

async function openWatch(id, item = {}) {
	const seq = ++watchSeq;
	const list = item.list || new URLSearchParams(location.search).get("list");
	resetWatchUi();
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

	current = { id, segments: [], skipped: new Set(), muted: false, duration: 0 };
	startPlayer(id, list, seq);

	try {
		const d = await api(`/api/video/${encodeURIComponent(id)}`, { gl: settings.region });
		if (seq !== watchSeq) return;
		fillDetails(d, item);
	} catch (err) {
		if (seq === watchSeq && !item.title) $("#watch-title").textContent = "Video";
		console.warn(err);
	}
}

async function startPlayer(id, list, seq) {
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
	player = new window.YT.Player("player", {
		host: "https://www.youtube-nocookie.com",
		videoId: id,
		playerVars: {
			autoplay: settings.autoplay ? 1 : 0,
			rel: 0,
			playsinline: 1,
			iv_load_policy: 3,
			origin: location.origin,
			...(list ? { list, listType: "playlist" } : {}),
		},
		events: {
			onReady: () => {
				current.duration = player.getDuration?.() || current.duration;
				drawSegments();
			},
			onStateChange: (e) => {
				// Playlist advanced to another video: re-fetch its segments
				const vid = player?.getVideoData?.().video_id;
				if (vid && current && vid !== current.id && e.data === window.YT.PlayerState.PLAYING) {
					history.replaceState(history.state, "", urlFor(state.q, readFilters(), { v: vid, ...(list ? { list } : {}) }));
					openWatchDetailsOnly(vid);
				}
			},
		},
	});
	clearInterval(tick);
	tick = setInterval(skipLoop, 250);
}

async function openWatchDetailsOnly(id) {
	const seq = ++watchSeq;
	current = { id, segments: [], skipped: new Set(), muted: false, duration: 0 };
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
	const chUrl = safeUrl(d.channelUrl);
	if (chUrl) ch.href = chUrl;
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

	current.segments = d.sponsorblock || [];
	current.duration = d.lengthSeconds || current.segments[0]?.videoDuration || current.duration;
	renderSegments();
}

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
		jump.onclick = () => player?.seekTo?.(poi.start, true);
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
						h("button", { type: "button", class: "button tiny secondary", onclick: () => player?.seekTo?.(s.end, true) }, "Skip"),
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
	if (!dur || !current?.segments.length) return bar.replaceChildren();
	bar.replaceChildren(
		...current.segments
			.filter((s) => s.action !== "full" && s.action !== "chapter")
			.map((s) => {
				const info = SB[s.category] || { label: s.category, color: "#888" };
				const left = (s.start / dur) * 100;
				const width = Math.max(((s.end - s.start) / dur) * 100, 0.4);
				return h("span", { style: `left:${left}%;width:${width}%;background:${info.color}`, title: `${info.label} ${fmtTime(s.start)}–${fmtTime(s.end)}` });
			}),
	);
}

function skipLoop() {
	if (!player?.getCurrentTime || !current?.segments.length) return;
	let t;
	try {
		t = player.getCurrentTime();
	} catch {
		return;
	}
	let inMute = false;
	for (const s of current.segments) {
		if (!settings.skip[s.category]) continue;
		const inside = t >= s.start && t < s.end - 0.35;
		if (s.action === "skip" && inside && !current.skipped.has(s.uuid)) {
			current.skipped.add(s.uuid);
			player.seekTo(s.end, true);
			const label = SB[s.category]?.label || s.category;
			toast(`Skipped ${label} (${fmtTime(s.end - s.start)})`, { label: "Undo", run: () => player?.seekTo?.(s.start, true) });
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

function closeWatch() {
	watchSeq++;
	destroyPlayer();
	$("#player-slot").replaceChildren();
	current = null;
	if (watch.open) watch.close();
}

function requestCloseWatch() {
	if (history.state?.watch) history.back(); // popstate will close it
	else {
		history.replaceState({}, "", urlFor(state.q, readFilters()));
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
		.map(([k, v]) =>
			h("label", { class: "toggle" }, h("input", { type: "checkbox", "data-skip": k }), h("span", { class: "swatch", style: `background:${v.color}` }), v.label),
		),
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
	if (el.dataset.setting) settings[el.dataset.setting] = el.type === "checkbox" ? el.checked : el.value;
	if (el.dataset.skip) settings.skip[el.dataset.skip] = el.checked;
	saveSettings();
	if (["hideShorts", "dearrow", "region"].includes(el.dataset.setting) && state.q) runSearch();
});
$("#open-settings").addEventListener("click", () => {
	syncSettingsForm();
	settingsDlg.showModal();
});
settingsDlg.addEventListener("click", (e) => e.target === settingsDlg && settingsDlg.close());

// ---------------------------------------------------------------------------------------------
// VRChat link helpers, keyboard, boot
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
	const params = new URLSearchParams(location.search);
	const q = (params.get("q") || "").trim();
	writeFilters(params);
	input.value = q;
	const key = `${q}|${JSON.stringify(readFilters())}|${settings.hideShorts}|${settings.region}`;
	if (key !== state.key) {
		state.key = key;
		state.q = q;
		state.next = null;
		if (q) runSearch();
		else showHome(true);
	}
	const v = params.get("v");
	if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) {
		if (current?.id !== v) {
			const card = $(`.card.video[data-id="${CSS.escape(v)}"]`);
			openWatch(v, card?._item || {});
		}
	} else if (watch.open) {
		closeWatch();
	}
}

window.addEventListener("popstate", syncFromUrl);
syncFromUrl();
