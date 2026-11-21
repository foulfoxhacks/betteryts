// TikTok sign-in for in-world linking (Login Kit for Web + Display API). No Workers imports, so
// Node tests can load it. Flow: docs/vrchat-protocol.md#linking.
//
// Unlike YouTube and Spotify (imported in the player's browser), TikTok's token exchange needs the
// app's client secret, so it runs here: /inworld/tiktok → TikTok consent → /tt/callback, which
// exchanges the code, reads the profile name and the public video list, then revokes the token
// straight away. No TikTok token, open_id or avatar is ever stored; only the video list (and the
// display name shown in the world) goes into the linked library, like any other link.
//
// TikTok gives no playable video file, and we don't scrape or re-host any: the world gets titles,
// covers, durations and each video's official embed_link only.
//
// Keys: TIKTOK_CLIENT_KEY / TIKTOK_SANDBOX_CLIENT_KEY are public text bindings; TIKTOK_MODE picks
// the pair. Secrets: TIKTOK_CLIENT_SECRET / TIKTOK_SANDBOX_CLIENT_SECRET are Worker secrets, never in
// the repo, config or logs.

import type { LinkLibrary, LinkTrack } from "../vrc/links-core.ts";

export const TIKTOK_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API = "https://open.tiktokapis.com";
export const TIKTOK_SCOPES = "user.info.basic,video.list";
export const TIKTOK_CALLBACK = "/tt/callback";
export const TIKTOK_USER_FIELDS = "open_id,display_name,avatar_url";
export const TIKTOK_VIDEO_FIELDS = "id,title,cover_image_url,duration,embed_link";
export const TIKTOK_PAGE_SIZE = 20; // Display API maximum
export const TIKTOK_MAX_PAGES = 5; // up to 100 videos per link
export const TIKTOK_PLAYLIST = "My TikTok videos";
const STATE_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface TikTokConfig {
	clientKey: string;
	clientSecret: string;
}

/**
 * The key/secret pair TIKTOK_MODE selects: "live" uses TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET,
 * anything else (default) the sandbox app's TIKTOK_SANDBOX_CLIENT_KEY / TIKTOK_SANDBOX_CLIENT_SECRET.
 * Keys are public text bindings; secrets are Worker secrets. Null if the chosen pair isn't complete.
 */
export function tiktokConfig(env: unknown): TikTokConfig | null {
	const e = env as Record<string, unknown>;
	const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
	const live = str("TIKTOK_MODE").toLowerCase() === "live";
	const clientKey = str(live ? "TIKTOK_CLIENT_KEY" : "TIKTOK_SANDBOX_CLIENT_KEY");
	const clientSecret = str(live ? "TIKTOK_CLIENT_SECRET" : "TIKTOK_SANDBOX_CLIENT_SECRET");
	return clientKey && clientSecret ? { clientKey, clientSecret } : null;
}

/**
 * Did this form POST come from our own pages? Our TikTok pages use `Referrer-Policy: no-referrer`,
 * and Chrome-family browsers (Chrome, Brave, Edge) then send `Origin: null` even on a same-site form
 * post. So "null" counts only when the browser's own Sec-Fetch-Site (which a page can't set) says
 * same-origin. No Origin at all (old browsers, curl) is allowed, as before; cross-site never is.
 */
export function sameSitePost(origin: string | null, secFetchSite: string | null, selfOrigin: string): boolean {
	if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return false;
	if (!origin) return true;
	if (origin === selfOrigin) return true;
	return origin === "null" && secFetchSite === "same-origin";
}

/** A random OAuth state (32 bytes, base64url). */
export function newState(): string {
	const b = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const validState = (s: unknown): s is string => typeof s === "string" && STATE_RE.test(s);

/** TikTok's consent page. `disable_auto_auth=1` always shows it, so nobody is linked without seeing it. */
export function tiktokAuthorizeUrl(origin: string, clientKey: string, state: string): string {
	const u = new URL(TIKTOK_AUTHORIZE);
	u.searchParams.set("client_key", clientKey);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("scope", TIKTOK_SCOPES);
	u.searchParams.set("redirect_uri", origin + TIKTOK_CALLBACK);
	u.searchParams.set("state", state);
	u.searchParams.set("disable_auto_auth", "1");
	return u.toString();
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class TikTokError extends Error {}

const form = (o: Record<string, string>) => ({
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams(o).toString(),
});

/** Code → access token (server side; the secret never leaves the Worker). */
export async function exchangeCode(cfg: TikTokConfig, origin: string, code: string, f: Fetch = fetch): Promise<string> {
	const res = await f(`${TIKTOK_API}/v2/oauth/token/`, form({ client_key: cfg.clientKey, client_secret: cfg.clientSecret, code, grant_type: "authorization_code", redirect_uri: origin + TIKTOK_CALLBACK }));
	const d = (await res.json().catch(() => null)) as { access_token?: unknown; scope?: unknown; error?: unknown; error_description?: unknown } | null;
	if (!res.ok || typeof d?.access_token !== "string" || !d.access_token) throw new TikTokError(`TikTok sign-in failed${typeof d?.error_description === "string" ? `: ${d.error_description.slice(0, 200)}` : ""}`);
	const granted = typeof d.scope === "string" ? d.scope.split(",").map((s) => s.trim()) : [];
	if (!granted.includes("video.list")) throw new TikTokError("BetterYTS needs permission to list your videos (video.list) to send them to the world");
	return d.access_token;
}

/** Ends the token as soon as the import is done. Errors are ignored: the token expires anyway. */
export async function revokeToken(cfg: TikTokConfig, token: string, f: Fetch = fetch): Promise<void> {
	try {
		await f(`${TIKTOK_API}/v2/oauth/revoke/`, form({ client_key: cfg.clientKey, client_secret: cfg.clientSecret, token }));
	} catch {
		/* expires within hours */
	}
}

function apiError(d: { error?: { code?: unknown; message?: unknown } } | null, what: string): TikTokError | null {
	const code = d?.error?.code;
	if (code === "ok" || code === undefined) return null;
	return new TikTokError(`TikTok couldn't ${what}${typeof d?.error?.message === "string" && d.error.message ? `: ${d.error.message.slice(0, 200)}` : ""}`);
}

export interface TikTokUser {
	displayName: string;
	avatarUrl: string;
}

/** user.info.basic: the name and picture shown on the confirmation page. */
export async function fetchUser(token: string, f: Fetch = fetch): Promise<TikTokUser> {
	const res = await f(`${TIKTOK_API}/v2/user/info/?fields=${TIKTOK_USER_FIELDS}`, { headers: { Authorization: `Bearer ${token}` } });
	const d = (await res.json().catch(() => null)) as { data?: { user?: { display_name?: unknown; avatar_url?: unknown } }; error?: { code?: unknown; message?: unknown } } | null;
	const err = apiError(d, "read your profile");
	if (err || !res.ok) throw err ?? new TikTokError("TikTok couldn't read your profile");
	const u = d?.data?.user;
	return { displayName: clip(u?.display_name, 80) || "TikTok user", avatarUrl: httpsUrl(u?.avatar_url) ?? "" };
}

export interface TikTokVideo {
	id: string;
	title: string;
	cover: string | null;
	duration: number;
	embed: string;
}

/** video.list: the user's public videos, newest first (up to TIKTOK_MAX_PAGES pages). */
export async function fetchVideos(token: string, f: Fetch = fetch): Promise<TikTokVideo[]> {
	const out: TikTokVideo[] = [];
	let cursor: number | undefined;
	for (let page = 0; page < TIKTOK_MAX_PAGES; page++) {
		const res = await f(`${TIKTOK_API}/v2/video/list/?fields=${TIKTOK_VIDEO_FIELDS}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(cursor === undefined ? { max_count: TIKTOK_PAGE_SIZE } : { max_count: TIKTOK_PAGE_SIZE, cursor }),
		});
		const d = (await res.json().catch(() => null)) as { data?: { videos?: unknown; cursor?: unknown; has_more?: unknown }; error?: { code?: unknown; message?: unknown } } | null;
		const err = apiError(d, "list your videos");
		if (err || !res.ok) throw err ?? new TikTokError("TikTok couldn't list your videos");
		for (const v of Array.isArray(d?.data?.videos) ? d.data.videos : []) {
			const video = cleanVideo(v);
			if (video && !out.some((o) => o.id === video.id)) out.push(video);
		}
		if (d?.data?.has_more !== true || typeof d.data.cursor !== "number") break;
		cursor = d.data.cursor;
	}
	return out;
}

const clip = (s: unknown, n: number) =>
	String(s ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, n);

function httpsUrl(s: unknown): string | null {
	if (typeof s !== "string" || s.length > 2048) return null;
	try {
		const u = new URL(s);
		return u.protocol === "https:" ? u.toString() : null;
	} catch {
		return null;
	}
}

/** Keeps only the fields we use; the embed must be TikTok's own player. */
export function cleanVideo(raw: unknown): TikTokVideo | null {
	const v = raw as { id?: unknown; title?: unknown; cover_image_url?: unknown; duration?: unknown; embed_link?: unknown } | null;
	const id = typeof v?.id === "string" ? v.id : typeof v?.id === "number" ? String(v.id) : "";
	if (!/^\d{1,32}$/.test(id)) return null;
	const embed = httpsUrl(v?.embed_link);
	if (!embed || !/^(www\.)?tiktok\.com$/.test(new URL(embed).hostname)) return null;
	const duration = typeof v?.duration === "number" && Number.isFinite(v.duration) && v.duration >= 0 ? Math.round(v.duration) : 0;
	return { id, title: clip(v?.title, 120) || "TikTok video", cover: httpsUrl(v?.cover_image_url), duration, embed };
}

/** The library sent to the world: one "playlist" of the user's public videos. */
export function tiktokLibrary(user: TikTokUser, videos: TikTokVideo[]): LinkLibrary {
	const tracks: LinkTrack[] = videos.slice(0, TIKTOK_PAGE_SIZE * TIKTOK_MAX_PAGES).map((v) => ({ id: v.id, title: v.title, channel: user.displayName, embed: v.embed, cover: v.cover, duration: v.duration }));
	return { service: "tiktok", account: user.displayName, playlists: [{ name: TIKTOK_PLAYLIST, tracks }] };
}

// ---- Pages (server-rendered; the SPA's link view handles YouTube and Spotify) ----

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function shell(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta name="referrer" content="no-referrer" />
<title>${esc(title)} · BetterYTS</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#18191a;--link:#065fd4}
@media (prefers-color-scheme:dark){:root{--bg:#18191a;--fg:#e4e6eb;--link:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link)}
.tt{max-width:640px;margin:0 auto;padding:32px 16px 48px}
.tt h1{font-size:1.6rem;margin:0 0 8px}
.tt form{display:grid;gap:14px;margin:20px 0}
.tt label.code input{font:inherit;font-size:1.4rem;letter-spacing:.12em;text-transform:uppercase;padding:10px 12px;width:100%;max-width:14ch;box-sizing:border-box}
.tt .btn-tt{font:inherit;font-weight:600;padding:12px 18px;border-radius:999px;border:0;background:#fe2c55;color:#fff;cursor:pointer;justify-self:start}
.tt .who{display:flex;align-items:center;gap:12px;margin:16px 0}
.tt .who img{width:56px;height:56px;border-radius:50%;object-fit:cover}
.tt ul.vids{list-style:none;padding:0;display:grid;gap:10px}
.tt ul.vids li{display:flex;gap:10px;align-items:center}
.tt ul.vids img{width:54px;height:72px;object-fit:cover;border-radius:6px;background:#0002}
.tt .fine{opacity:.8;font-size:.92rem}
.tt .err{color:#e5484d;font-weight:600}
</style>
</head>
<body>
<main class="tt">
<p class="fine"><a href="/">BetterYTS</a> › Send to VRChat</p>
${body}
<p class="fine"><a href="/privacy#tiktok">Privacy</a> · <a href="/terms">Terms</a></p>
</main>
</body>
</html>`;
}

/** /inworld/tiktok: enter the world's code, choose how long to keep it, continue to TikTok. */
export function tiktokCodePage(code: string, error = "", configured = true): string {
	return shell(
		"Link TikTok",
		`<h1>Link TikTok to a VRChat world</h1>
<p>Enter the code shown in the world. You'll sign in on TikTok's own page and BetterYTS will send a list of your <b>public</b> TikTok videos (titles, covers and TikTok's embed links) and your TikTok display name to the world.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
${
	configured
		? `<form method="post" action="/tt/start">
<label class="code">Code from the world<br /><input name="code" value="${esc(code)}" placeholder="K7QX-M2PA" autocomplete="off" autocapitalize="characters" required maxlength="12" /></label>
<label><input type="checkbox" name="save" value="1" /> Save for my next visit (kept up to 30 days; otherwise deleted when the code expires in 10 minutes)</label>
<button class="btn-tt" type="submit">Continue with TikTok</button>
</form>`
		: `<p class="err">TikTok linking isn't set up on this server yet.</p>`
}
<p class="fine">We ask TikTok for <b>user.info.basic</b> (your display name and picture, shown on the next page) and <b>video.list</b> (your public videos). Your TikTok sign-in is ended right after the list is read: no TikTok token is stored. Nothing is posted to your account.</p>`,
	);
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** After the callback: who signed in (user.info.basic) and what was sent (video.list). */
export function tiktokDonePage(user: TikTokUser, videos: TikTokVideo[], saved: boolean): string {
	const list = videos.length
		? `<ul class="vids">${videos
				.map((v) => `<li>${v.cover ? `<img src="${esc(v.cover)}" alt="" loading="lazy" />` : ""}<span><a href="${esc(v.embed)}" target="_blank" rel="noopener">${esc(v.title)}</a><br /><span class="fine">${mmss(v.duration)}</span></span></li>`)
				.join("")}</ul>`
		: `<p>You have no public videos yet, so the world will show an empty list.</p>`;
	return shell(
		"Linked",
		`<h1>Sent to the world</h1>
<div class="who">${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="" />` : ""}<div>Signed in to TikTok as <b>${esc(user.displayName)}</b></div></div>
<p>${videos.length} public video${videos.length === 1 ? "" : "s"} sent. ${saved ? "Saved for your next visit (up to 30 days); press Unlink in the world to delete it sooner." : "Just for this visit: deleted when the code expires."} Your TikTok sign-in has been ended.</p>
${list}
<p>You can go back to VRChat now.</p>`,
	);
}

export function tiktokErrorPage(message: string): string {
	return shell("TikTok linking", `<h1>That didn't work</h1><p class="err" role="alert">${esc(message)}</p><p><a href="/inworld/tiktok">Try again</a> with a new code from the world.</p>`);
}
