// "Sign in with Google" broker for the BetterYTS Music app (read-only YouTube library import).
//
// Flow (PKCE; the client secret never leaves the Worker, the code verifier never leaves the phone):
//   1. App opens  /auth/google/start?state=…&code_challenge=…      → 302 to Google's consent page
//   2. Google →   /auth/google/callback?code=…&state=…             → 302 to betterytsmusic://oauth?code=…&state=…
//                 (states starting "web_" go back to the website instead: /?link=google&code=…&state=…)
//   3. App POSTs  /api/auth/google/token   {code, code_verifier}   → Worker adds the secret, returns tokens
//   4. Later:     /api/auth/google/refresh {refresh_token}         → new access token
//                 /api/auth/google/revoke  {token}                 → sign out
// Tokens pass through the Worker; nothing is stored or logged here.

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const APP_REDIRECT = "betterytsmusic://oauth";
export const CALLBACK_PATH = "/auth/google/callback";

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(SHA-256) without padding
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636
const CODE_RE = /^[\x21-\x7e]{10,1024}$/;
const TOKEN_RE = /^[\x21-\x7e]{10,4096}$/;

export interface GoogleConfig {
	clientId: string;
	clientSecret: string;
}

export function googleConfig(env: unknown): GoogleConfig | null {
	const e = env as { GOOGLE_CLIENT_ID?: unknown; GOOGLE_CLIENT_SECRET?: unknown };
	const clientId = typeof e.GOOGLE_CLIENT_ID === "string" ? e.GOOGLE_CLIENT_ID.trim() : "";
	const clientSecret = typeof e.GOOGLE_CLIENT_SECRET === "string" ? e.GOOGLE_CLIENT_SECRET.trim() : "";
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Google consent URL for step 1, or an error message for bad input. */
export function authorizeUrl(origin: string, clientId: string, state: string | null, challenge: string | null): string | { error: string } {
	if (!state || !STATE_RE.test(state)) return { error: "Missing or invalid state" };
	if (!challenge || !CHALLENGE_RE.test(challenge)) return { error: "Missing or invalid code_challenge (S256)" };
	const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	u.searchParams.set("client_id", clientId);
	u.searchParams.set("redirect_uri", origin + CALLBACK_PATH);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("scope", GOOGLE_SCOPE);
	u.searchParams.set("access_type", "offline");
	u.searchParams.set("prompt", "consent");
	u.searchParams.set("include_granted_scopes", "true");
	u.searchParams.set("state", state);
	u.searchParams.set("code_challenge", challenge);
	u.searchParams.set("code_challenge_method", "S256");
	return u.toString();
}

/** Step 2: hand Google's answer to the app. Only well-formed values are passed on. */
export function appRedirect(params: URLSearchParams): string {
	const out = new URLSearchParams();
	const state = params.get("state");
	if (state && STATE_RE.test(state)) out.set("state", state);
	const code = params.get("code");
	const error = params.get("error");
	if (code && CODE_RE.test(code)) out.set("code", code);
	else out.set("error", error && /^[a-z_]{1,64}$/.test(error) ? error : "invalid_response");
	return `${APP_REDIRECT}?${out}`;
}

/**
 * Where Google's answer goes. States starting "web_" came from the website (web/accounts.js),
 * which finishes the same PKCE exchange in the browser; everything else goes to the app.
 */
export function callbackRedirect(origin: string, params: URLSearchParams): string {
	const state = params.get("state") ?? "";
	if (!state.startsWith("web_")) return appRedirect(params);
	const app = new URL(appRedirect(params));
	return `${origin}/?link=google&${app.searchParams}`;
}

export function validTokenRequest(body: unknown): { code: string; verifier: string } | null {
	const b = body as { code?: unknown; code_verifier?: unknown } | null;
	if (!b || typeof b.code !== "string" || typeof b.code_verifier !== "string") return null;
	return CODE_RE.test(b.code) && VERIFIER_RE.test(b.code_verifier) ? { code: b.code, verifier: b.code_verifier } : null;
}

export function validToken(value: unknown): string | null {
	return typeof value === "string" && TOKEN_RE.test(value) ? value : null;
}

export interface TokenReply {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
}

/** Calls Google's token endpoint. Returns the tokens, or Google's own error text. */
export async function googleToken(params: Record<string, string>): Promise<TokenReply | { error: string; status: number }> {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok || typeof data.access_token !== "string") {
		const msg = typeof data.error_description === "string" ? data.error_description : typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
		return { error: `Google: ${msg}`, status: res.status >= 500 ? 502 : 400 };
	}
	const out: TokenReply = { access_token: data.access_token, expires_in: typeof data.expires_in === "number" ? data.expires_in : 3600 };
	if (typeof data.refresh_token === "string") out.refresh_token = data.refresh_token;
	if (typeof data.scope === "string") out.scope = data.scope;
	return out;
}
