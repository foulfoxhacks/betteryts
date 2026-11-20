// Account imports on the website: sign in with Google (YouTube) once, copy your playlists, liked
// videos and subscriptions into this browser's library, then revoke the token. Nothing is kept:
// the access token lives in memory for the import, and the Worker only adds its client secret to
// the PKCE exchange (src/lib/google.ts; the same broker BetterYTS Music uses).

const PENDING = "betteryts.oauth.pending.v1";
const YT_API = "https://www.googleapis.com/youtube/v3";

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Starts Google sign-in. `purpose` comes back after the redirect (e.g. "import", or "link:CODE"). */
export async function startGoogle(purpose = "import") {
	const verifier = random(48); // 64 chars, RFC 7636 alphabet
	const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	const state = `web_${random(24)}`;
	sessionStorage.setItem(PENDING, JSON.stringify({ service: "google", state, verifier, purpose, at: Date.now() }));
	location.assign(`/auth/google/start?${new URLSearchParams({ state, code_challenge: challenge })}`);
}

/** After the redirect: checks the state and swaps the code for an access token. */
export async function finishGoogle(params) {
	let pending = null;
	try {
		pending = JSON.parse(sessionStorage.getItem(PENDING) || "null");
	} catch {
		/* ignore */
	}
	sessionStorage.removeItem(PENDING);
	if (!pending || pending.service !== "google" || pending.state !== params.get("state") || Date.now() - pending.at > 15 * 60_000) {
		throw new Error("That sign-in link expired or didn't start here. Try again.");
	}
	const error = params.get("error");
	if (error) throw new Error(error === "access_denied" ? "Sign-in was cancelled" : `Google said: ${error}`);
	const res = await fetch("/api/auth/google/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code: params.get("code"), code_verifier: pending.verifier }),
	});
	const body = await res.json().catch(() => null);
	if (!res.ok || !body?.access_token) throw new Error(body?.error?.message || "Google sign-in failed");
	return { token: body.access_token, purpose: pending.purpose };
}

/** Signs out at Google so the token can't be used again. Best effort. */
export async function revokeGoogle(token) {
	try {
		await fetch("/api/auth/google/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
	} catch {
		/* the token expires within the hour anyway */
	}
}

async function yt(token, resource, query) {
	const res = await fetch(`${YT_API}/${resource}?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } });
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(body?.error?.message || `YouTube ${resource}: HTTP ${res.status}`);
	return body;
}

async function paged(token, resource, query, max) {
	const out = [];
	let pageToken = "";
	do {
		const page = await yt(token, resource, { ...query, maxResults: "50", ...(pageToken ? { pageToken } : {}) });
		out.push(...(page.items || []));
		pageToken = page.nextPageToken || "";
	} while (pageToken && out.length < max);
	return out.slice(0, max);
}

const thumb = (sn) => sn?.thumbnails?.medium?.url || sn?.thumbnails?.high?.url || sn?.thumbnails?.default?.url || null;
const iso = (d) => {
	const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
	if (!m) return "";
	const s = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
	const mm = String(Math.floor((s % 3600) / 60));
	const ss = String(s % 60).padStart(2, "0");
	return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
};

/** The signed-in account's playlists (with items), liked videos and subscriptions. */
export async function youtubeLibrary(token, onProgress = () => {}) {
	onProgress("Reading your playlists…");
	const lists = await paged(token, "playlists", { part: "snippet", mine: "true" }, 100);
	const playlists = [];
	for (const [i, p] of lists.entries()) {
		onProgress(`Reading playlist ${i + 1} of ${lists.length}…`);
		const items = await paged(token, "playlistItems", { part: "snippet,contentDetails", playlistId: p.id }, 500);
		playlists.push({
			source: `youtube:${p.id}`,
			name: p.snippet?.title || "Playlist",
			items: items
				.filter((it) => it.snippet?.videoOwnerChannelTitle) // deleted/private videos have no owner
				.map((it) => ({ id: it.contentDetails?.videoId || it.snippet?.resourceId?.videoId, title: it.snippet.title, channel: it.snippet.videoOwnerChannelTitle, channelRef: it.snippet.videoOwnerChannelId, thumbnail: thumb(it.snippet) })),
		});
	}
	onProgress("Reading liked videos…");
	const liked = (await paged(token, "videos", { part: "snippet,contentDetails", myRating: "like" }, 1000)).map((v) => ({ id: v.id, title: v.snippet?.title, channel: v.snippet?.channelTitle, channelRef: v.snippet?.channelId, thumbnail: thumb(v.snippet), duration: iso(v.contentDetails?.duration) }));
	onProgress("Reading subscriptions…");
	const subscriptions = (await paged(token, "subscriptions", { part: "snippet", mine: "true", order: "alphabetical" }, 500))
		.map((s) => ({ id: s.snippet?.resourceId?.channelId, title: s.snippet?.title, handle: null, avatar: thumb(s.snippet) }))
		.filter((c) => typeof c.id === "string");
	return { playlists, liked, subscriptions };
}
