// Small shared helpers. Everything from the API goes into the DOM via textContent/attributes.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, props = {}, ...children) {
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

export const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
export const isVideoId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{11}$/.test(v);

export function fmtTime(sec) {
	sec = Math.max(0, Math.round(sec));
	const hh = Math.floor(sec / 3600);
	const mm = Math.floor((sec % 3600) / 60);
	const ss = String(sec % 60).padStart(2, "0");
	return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

const nf = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const fmtCount = (n) => (typeof n === "number" ? nf.format(n) : "");

let toastTimer;
export function toast(message, action) {
	const el = $("#toast");
	el.replaceChildren(h("span", {}, message));
	if (action) el.append(h("button", { type: "button", class: "toast-btn", onclick: () => (action.run(), (el.hidden = true)) }, action.label));
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 2500);
}

export async function copy(textValue, what = "Link") {
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

export async function api(path, params = {}, signal) {
	const u = new URL(path, location.origin);
	for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, v);
	const res = await fetch(u, { signal });
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(body?.error?.message || `Request failed (${res.status})`);
	return body;
}

/** Keep only what the library needs from a search item or video details. */
export function minVideo(v) {
	if (!v || !isVideoId(v.id)) return null;
	return {
		id: v.id,
		title: String(v.branding?.title || v.title || v.id).slice(0, 200),
		channel: String(typeof v.channel === "string" ? v.channel : v.channel?.name || v.author || "").slice(0, 100),
		channelRef: typeof v.channel === "object" ? v.channel?.handle || v.channel?.id || null : v.channelRef || null,
		thumbnail: safeUrl(v.thumbnail) || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
		duration: v.live ? "LIVE" : String(v.duration || ""),
	};
}
