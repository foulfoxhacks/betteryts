// /api/sync/{vaultId}: GET (download), PUT (upload, versioned), DELETE (erase). Responses use the
// v1 envelope ({ ok, data, meta } / { ok: false, error }) and are never cached. Same-origin only for
// browsers (no CORS headers); the apps aren't browsers. See docs/sync.md.

import type { SyncVault, VaultResult } from "./vault.ts";
import { isVaultId } from "./vault.ts";

type Ns = { getByName(name: string): Pick<SyncVault, "read" | "write" | "erase"> };

const MAX_BODY = 3_200_000;

function reply(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
	});
}

const ok = (data: unknown) => reply(200, { ok: true, data, meta: { apiVersion: "1" } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
	reply(status, { ok: false, error: { code, message, retryable: status === 429 || status >= 500, ...extra }, meta: { apiVersion: "1" } });

async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function result(r: VaultResult): Response {
	if (r.ok) return ok({ version: r.version, updatedAt: r.updatedAt, ...(r.data ? { iv: r.iv, data: r.data } : {}) });
	return fail(r.status, r.code, r.message, r.version !== undefined ? { version: r.version } : {});
}

export async function syncRoutes(req: Request, path: string, ns: Ns): Promise<Response> {
	const m = /^\/api\/sync\/([^/]+)$/.exec(path);
	if (!m || !isVaultId(m[1])) return fail(404, "NOT_FOUND", "Unknown sync endpoint");
	const auth = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get("Authorization") ?? "")?.[1];
	if (!auth) return fail(401, "UNAUTHORIZED", "Missing sync credentials");
	// Browsers: only this site's own pages may call it.
	const origin = req.headers.get("Origin");
	if (origin && origin !== new URL(req.url).origin) return fail(403, "FORBIDDEN", "Cross-site sync requests aren't allowed");
	const vault = ns.getByName(m[1]);
	const authHash = await sha256Hex(auth);
	if (req.method === "GET") return result(await vault.read(authHash));
	if (req.method === "DELETE") return result(await vault.erase(authHash));
	if (req.method === "PUT") {
		const len = Number(req.headers.get("Content-Length") ?? 0);
		if (len > MAX_BODY) return fail(413, "TOO_LARGE", "That library is too big to sync");
		const raw = await req.text();
		if (raw.length > MAX_BODY) return fail(413, "TOO_LARGE", "That library is too big to sync");
		let body: { iv?: unknown; data?: unknown; baseVersion?: unknown };
		try {
			body = JSON.parse(raw);
		} catch {
			return fail(400, "BAD_REQUEST", "Expected JSON");
		}
		if (typeof body.iv !== "string" || typeof body.data !== "string" || !Number.isInteger(body.baseVersion) || (body.baseVersion as number) < 0) {
			return fail(400, "BAD_REQUEST", "Expected { iv, data, baseVersion }");
		}
		return result(await vault.write(authHash, body.baseVersion as number, body.iv, body.data));
	}
	return fail(405, "METHOD_NOT_ALLOWED", "Use GET, PUT or DELETE");
}
