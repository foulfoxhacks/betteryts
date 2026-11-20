// "Sign in with Spotify" for the site and BetterYTS Music: read your playlists and Liked Songs.
//
// Spotify supports PKCE for public clients, so there's no client secret: the browser (or app)
// swaps the code for a token directly with Spotify. The Worker only starts the flow (adding the
// client ID and redirect URI) and routes the callback, like the Google broker:
//   /auth/spotify/start?state=…&code_challenge=…  → 302 to Spotify's consent page
//   /auth/spotify/callback?code=…&state=…         → states starting "web_" go to the site
//                                                    (/?link=spotify&…), others to the app
//                                                    (betterytsmusic://oauth/spotify?…)
//
// Setup (once, by the site owner): create an app at developer.spotify.com, add the redirect URI
// https://yts.foulfoxhacks.dev/auth/spotify/callback, and set SPOTIFY_CLIENT_ID on the Worker.
// Until then /api/auth/config reports spotify: false and the UI hides the button.

export const SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative user-library-read";
export const SPOTIFY_CALLBACK = "/auth/spotify/callback";

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9_-]{10,1024}$/;

export function spotifyClientId(env: unknown): string | null {
	const id = (env as { SPOTIFY_CLIENT_ID?: unknown }).SPOTIFY_CLIENT_ID;
	return typeof id === "string" && /^[0-9a-f]{32}$/i.test(id.trim()) ? id.trim() : null;
}

export function spotifyAuthorizeUrl(origin: string, clientId: string, state: string | null, challenge: string | null): string | { error: string } {
	if (!state || !STATE_RE.test(state)) return { error: "Missing or invalid state" };
	if (!challenge || !CHALLENGE_RE.test(challenge)) return { error: "Missing or invalid code_challenge (S256)" };
	const u = new URL("https://accounts.spotify.com/authorize");
	u.searchParams.set("client_id", clientId);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("redirect_uri", origin + SPOTIFY_CALLBACK);
	u.searchParams.set("scope", SPOTIFY_SCOPES);
	u.searchParams.set("state", state);
	u.searchParams.set("code_challenge_method", "S256");
	u.searchParams.set("code_challenge", challenge);
	return u.toString();
}

/** Where Spotify's answer goes; only well-formed values are passed on. */
export function spotifyCallbackRedirect(origin: string, params: URLSearchParams): string {
	const out = new URLSearchParams();
	const state = params.get("state") ?? "";
	if (STATE_RE.test(state)) out.set("state", state);
	const code = params.get("code");
	const error = params.get("error");
	if (code && CODE_RE.test(code)) out.set("code", code);
	else out.set("error", error && /^[a-z_]{1,64}$/.test(error) ? error : "invalid_response");
	return state.startsWith("web_") ? `${origin}/?link=spotify&${out}` : `betterytsmusic://oauth/spotify?${out}`;
}
