// BetterYTS Sync: end-to-end encrypted library sync with BetterYTS Music (Android, desktop) and other
// browsers. Same protocol as the app's core/src/sync.rs (spec: docs/sync.md):
//   sync code (BTS1-…, 32 random bytes) → SHA-256 with labels → vault ID, auth secret, AES-256-GCM key.
//   Payload { format: "betteryts-sync", version: 1, backup, ledger } where the ledger records, per
//   item, when it last changed and its content hash (or that it was removed). Newest change wins.
// The server (/api/sync/{id}) only ever stores ciphertext.

export const FORMAT = "betteryts-sync";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOMBSTONE_MS = 180 * 24 * 3600 * 1000;
const enc = new TextEncoder();

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- keys

export function newKey() {
	return crypto.getRandomValues(new Uint8Array(32));
}

/** BTS1-XXXX-… (52 Crockford base32 characters in groups of four). */
export function codeOf(key) {
	let bits = 0, n = 0, out = "";
	for (const b of key) {
		bits = ((bits << 8) | b) >>> 0;
		n += 8;
		while (n >= 5) {
			n -= 5;
			out += CROCKFORD[(bits >>> n) & 31];
		}
		bits &= (1 << n) - 1;
	}
	if (n > 0) out += CROCKFORD[(bits << (5 - n)) & 31];
	return "BTS1-" + out.match(/.{1,4}/g).join("-");
}

/** Forgiving parse (any case, with or without dashes, O/I/L as 0/1/1). Null if it isn't a code. */
export function parseCode(code) {
	let body = String(code || "").trim().toUpperCase();
	if (body.startsWith("BTS1")) body = body.slice(4);
	const chars = [...body].filter((c) => /[A-Z0-9]/.test(c)).map((c) => (c === "O" ? "0" : c === "I" || c === "L" ? "1" : c));
	if (chars.length !== 52) return null;
	let bits = 0, n = 0;
	const out = [];
	for (const c of chars) {
		const v = CROCKFORD.indexOf(c);
		if (v < 0) return null;
		bits = ((bits << 5) | v) >>> 0;
		n += 5;
		if (n >= 8) {
			n -= 8;
			out.push((bits >>> n) & 0xff);
			bits &= (1 << n) - 1;
		}
	}
	return Uint8Array.from(out.slice(0, 32));
}

async function sub(key, label) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`betteryts-sync:${label}:${hex(key)}`)));
}
export const vaultId = async (key) => hex(await sub(key, "id")).slice(0, 32);
export const authOf = async (key) => hex(await sub(key, "auth"));

async function aesKey(key) {
	return crypto.subtle.importKey("raw", await sub(key, "enc"), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(key, plaintext) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(await vaultId(key)) }, await aesKey(key), enc.encode(plaintext));
	return { iv: b64(iv), data: b64(new Uint8Array(ct)) };
}

export async function decrypt(key, iv, data) {
	try {
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(await vaultId(key)) }, await aesKey(key), unb64(data));
		return new TextDecoder().decode(pt);
	} catch {
		throw new Error("The synced library couldn't be decrypted (wrong code?)");
	}
}

// ---------------------------------------------------------------- items, ledger, merge

/** FNV-1a 32-bit over UTF-8, hex (matches the app). */
export function fnv(s) {
	let h = 0x811c9dc5;
	for (const b of enc.encode(s)) {
		h ^= b;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

function ruleText(r) {
	const f = (k) => {
		const v = r?.[k];
		if (typeof v === "number") return String(Math.round(v));
		if (typeof v === "string") return v;
		if (typeof v === "boolean") return v ? "1" : "0";
		return "";
	};
	return ["source", "minSeconds", "maxSeconds", "artist", "title", "minPlays", "maxPlays", "playedWithinDays", "notPlayedForDays", "excludeLive", "excludeDevice", "sort", "limit"].map(f).join("|");
}

function settingsText(st) {
	const skip = Object.entries(st?.skip && typeof st.skip === "object" ? st.skip : {}).filter(([, v]) => v === true).map(([k]) => k).sort();
	return `${str(st?.hiddenChannels)}|${str(st?.hiddenWords)}|${skip.join(",")}`;
}

/** key → [hash, value]. f: liked, c: subscriptions, p: playlists, d: disliked, s: smart, settings. */
export function items(backup) {
	const m = new Map();
	const lib = backup?.library ?? {};
	for (const [prefix, list] of [["f:", lib.favorites], ["c:", lib.subscriptions], ["d:", lib.disliked]]) {
		for (const v of arr(list)) if (str(v?.id)) m.set(prefix + v.id, ["1", v]);
	}
	for (const p of arr(lib.playlists)) {
		if (str(p?.id)) m.set("p:" + p.id, [fnv(`${str(p.name)}\n${arr(p.items).map((t) => str(t?.id)).join(",")}`), p]);
	}
	for (const r of arr(backup?.music?.smart)) {
		const name = str(r?.name).toLowerCase();
		if (name) m.set("s:" + name, [fnv(ruleText(r.rule)), r]);
	}
	if (backup?.settings && typeof backup.settings === "object") m.set("settings", [fnv(settingsText(backup.settings)), backup.settings]);
	return m;
}

/** Records local changes since the last sync. ledger: { key: [at, hash|null] }; snapshot: { key: hash }. */
export function updateLedger(ledger, snapshot, now, at) {
	for (const [k, [h]] of now) if (snapshot[k] !== h) ledger[k] = [at, h];
	for (const k of Object.keys(snapshot)) if (!now.has(k)) ledger[k] = [at, null];
	return ledger;
}

const newer = (a, b) => {
	if (a[0] !== b[0]) return a[0] > b[0];
	if ((a[1] !== null) !== (b[1] !== null)) return a[1] !== null;
	return String(a[1] ?? "") > String(b[1] ?? "");
};

export function mergeLedgers(a, b) {
	const out = { ...a };
	for (const [k, e] of Object.entries(b)) if (!out[k] || newer(e, out[k])) out[k] = e;
	return out;
}

export function prune(ledger, now) {
	for (const [k, e] of Object.entries(ledger)) if (e[1] === null && now - e[0] >= TOMBSTONE_MS) delete ledger[k];
	return ledger;
}

/** The merged backup: `local` with its synced sections rebuilt from the ledger's winners. */
export function compose(ledger, local, remote) {
	const li = items(local), ri = items(remote);
	const pick = (k, h) => {
		for (const m of [li, ri]) if (m.get(k)?.[0] === h) return m.get(k)[1];
		return (li.get(k) ?? ri.get(k))?.[1];
	};
	const live = (prefix) =>
		Object.entries(ledger)
			.filter(([k, e]) => k.startsWith(prefix) && e[1] !== null)
			.map(([k, e]) => [e[0], pick(k, e[1])])
			.filter(([, v]) => v)
			.sort((a, b) => b[0] - a[0] || (str(a[1].id) < str(b[1].id) ? -1 : 1));
	const ordered = (prefix, localList) => {
		const liveItems = live(prefix);
		const ids = arr(localList).map((v) => str(v?.id));
		const out = liveItems.filter(([, v]) => !ids.includes(str(v.id))).map(([, v]) => v);
		for (const id of ids) {
			const hit = liveItems.find(([, v]) => str(v.id) === id);
			if (hit) out.push(hit[1]);
		}
		return out;
	};
	const out = structuredClone(local);
	out.library ??= {};
	const L = local.library ?? {};
	out.library.favorites = ordered("f:", L.favorites);
	out.library.subscriptions = ordered("c:", L.subscriptions);
	out.library.disliked = ordered("d:", L.disliked);
	out.library.playlists = ordered("p:", L.playlists);
	const seen = new Set();
	out.library.history = [...arr(L.history), ...arr(remote?.library?.history)]
		.sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))
		.filter((h) => !seen.has(h?.id) && seen.add(h?.id))
		.slice(0, 300);
	out.music = { ...(out.music ?? {}), smart: live("s:").map(([, v]) => v) };
	const st = ledger.settings?.[1] ? pick("settings", ledger.settings[1]) : null;
	if (st) {
		out.settings ??= {};
		for (const k of ["hiddenChannels", "hiddenWords", "skip"]) if (st[k] !== undefined) out.settings[k] = st[k];
	}
	return out;
}

// ---------------------------------------------------------------- network round trip

/**
 * One sync. `state` = { code, version, snapshot, ledger } (persisted by the caller); `local` is this
 * browser's backup object. Returns { merged, changed, version }; throws on network/server errors.
 */
export async function syncOnce(state, local, { fetch: f = fetch, now = Date.now(), base = "" } = {}) {
	const key = parseCode(state.code);
	if (!key) throw new Error("Sync isn't set up in this browser");
	const url = `${base}/api/sync/${await vaultId(key)}`;
	const headers = { Authorization: `Bearer ${await authOf(key)}`, "Content-Type": "application/json" };
	const mine = items(local);
	state.ledger = updateLedger(state.ledger ?? {}, state.snapshot ?? {}, mine, now);
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await f(url, { headers, cache: "no-store" });
		const body = await res.json().catch(() => ({}));
		let remoteVersion = 0, remoteBackup = {}, remoteLedger = {};
		if (res.ok) {
			const payload = JSON.parse(await decrypt(key, body.data.iv, body.data.data));
			if (payload.format !== FORMAT) throw new Error("The synced library is from a newer version; reload the page");
			remoteVersion = body.data.version;
			remoteBackup = payload.backup ?? {};
			remoteLedger = payload.ledger ?? {};
		} else if (res.status !== 404) {
			throw new Error(body?.error?.message || `Sync failed (HTTP ${res.status})`);
		}
		const merged = prune(mergeLedgers(state.ledger, remoteLedger), now);
		const result = compose(merged, local, remoteBackup);
		const mergedItems = items(result);
		const sig = (m) => [...m].map(([k, [h]]) => `${k}=${h}`).sort().join(";");
		const changed = sig(mergedItems) !== sig(mine) || JSON.stringify(result.library?.history) !== JSON.stringify(local.library?.history);
		let version = remoteVersion;
		if (remoteVersion === 0 || JSON.stringify(sortKeys(merged)) !== JSON.stringify(sortKeys(remoteLedger))) {
			const sealed = await encrypt(key, JSON.stringify({ format: FORMAT, version: 1, backup: result, ledger: merged }));
			const put = await f(url, { method: "PUT", headers, body: JSON.stringify({ ...sealed, baseVersion: remoteVersion }) });
			const pb = await put.json().catch(() => ({}));
			if (put.status === 409) continue;
			if (!put.ok) throw new Error(pb?.error?.message || `Sync failed (HTTP ${put.status})`);
			version = pb.data.version;
		}
		state.version = version;
		state.ledger = merged;
		state.snapshot = Object.fromEntries([...mergedItems].map(([k, [h]]) => [k, h]));
		state.lastSync = now;
		return { merged: result, changed, version };
	}
	throw new Error("Other devices kept syncing at the same time; try again in a moment");
}

function sortKeys(o) {
	return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export async function eraseVault(code, { fetch: f = fetch, base = "" } = {}) {
	const key = parseCode(code);
	if (!key) return;
	await f(`${base}/api/sync/${await vaultId(key)}`, { method: "DELETE", headers: { Authorization: `Bearer ${await authOf(key)}` } });
}
