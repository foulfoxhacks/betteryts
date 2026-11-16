// /vrc/* endpoints for in-world search (protocol v1, see docs/vrchat-protocol.md).

import { cached, CORS_HEADERS, redirect, text } from "../lib/http.ts";
import { search } from "../lib/innertube.ts";
import { boolParam, intParam, queryFromSearchParams } from "../lib/query.ts";
import type { ClientOptions, Item, SearchFilters, VideoItem } from "../lib/types.ts";
import type { VrcPool } from "./pool.ts";
import { POOL_SIZE, PROTOCOL_VERSION, type SlotEntry } from "./protocol.ts";
import { renderSheet, SHEET, sheetLayout } from "./sheet.ts";

const PER_PAGE = SHEET.cols * SHEET.rows;

/** Everything needed to (re)build one page of in-world results. Stored in "page" slots. */
export interface PageCursor {
	q: string;
	sort?: SearchFilters["sort"];
	upload?: SearchFilters["upload"];
	live: boolean;
	minlen: number;
	maxlen: number;
	hl: string;
	gl: string;
	/** YouTube continuation token for the underlying results page (null = first page). */
	token: string | null;
	/** How many filtered videos of that underlying page were already shown. */
	offset: number;
}

const json = (data: unknown, maxAge = 0) =>
	new Response(JSON.stringify(data), {
		status: 200,
		headers: {
			...CORS_HEADERS,
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": maxAge ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : "no-store",
		},
	});

const fail = (error: string) => json({ v: PROTOCOL_VERSION, ok: false, error });

function pool(env: Env) {
	// One global pool instance; the binding names the Worker by string, so type it explicitly.
	return (env.VRC_POOL as unknown as DurableObjectNamespace<VrcPool>).getByName("pool-v1");
}

export function cursorFromUrl(url: URL, opts: ClientOptions): PageCursor {
	const sort = url.searchParams.get("sort");
	const upload = url.searchParams.get("upload");
	return {
		q: queryFromSearchParams(url),
		sort: (["rating", "date", "views"] as const).find((s) => s === sort),
		upload: (["hour", "today", "week", "month", "year"] as const).find((s) => s === upload),
		live: boolParam(url, "live", true),
		minlen: intParam(url, "minlen", 0, 0, 86400),
		maxlen: intParam(url, "maxlen", 0, 0, 86400),
		hl: opts.hl,
		gl: opts.gl,
		token: null,
		offset: 0,
	};
}

/** Videos that can actually play in a world player. */
export function playable(items: Item[], c: Pick<PageCursor, "live" | "minlen" | "maxlen">): VideoItem[] {
	return items.filter((i): i is VideoItem => {
		if (i.type !== "video" || i.isShort || i.upcoming || i.shelf) return false;
		if (i.live && !c.live) return false;
		if (c.minlen && (i.durationSeconds ?? 0) < c.minlen) return false;
		if (c.maxlen && i.durationSeconds !== null && i.durationSeconds > c.maxlen) return false;
		return true;
	});
}

/** Slice one page out of a results page and work out where the next one starts. */
export function paginate(videos: VideoItem[], cursor: PageCursor, youtubeNext: string | null) {
	const shown = videos.slice(cursor.offset, cursor.offset + PER_PAGE);
	let next: PageCursor | null = null;
	if (cursor.offset + PER_PAGE < videos.length) next = { ...cursor, offset: cursor.offset + PER_PAGE };
	else if (youtubeNext) next = { ...cursor, token: youtubeNext, offset: 0 };
	return { shown, next };
}

async function hashKey(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildPage(cursor: PageCursor, env: Env, clientVersion: string) {
	if (!cursor.q && !cursor.token) return fail("Type a search after q=");
	const filters: SearchFilters = { type: "video", sort: cursor.sort, upload: cursor.upload };
	const opts: ClientOptions = { hl: cursor.hl, gl: cursor.gl, clientVersion };
	const r = await search(cursor.q, filters, opts, cursor.token ?? undefined);
	const { shown, next } = paginate(playable(r.results, cursor), cursor, r.next);

	const entries: SlotEntry[] = shown.map((v) => ({ kind: "video", key: `v:${v.id}`, payload: v.id }));
	const ids = shown.map((v) => v.id);
	if (ids.length) entries.push({ kind: "sheet", key: `s:${ids.join(",")}`, payload: JSON.stringify(ids) });
	if (next) {
		const payload = JSON.stringify(next);
		entries.push({ kind: "page", key: `p:${await hashKey(payload)}`, payload });
	}
	const slots = entries.length ? await pool(env).assign(entries) : [];

	return json(
		{
			v: PROTOCOL_VERSION,
			ok: true,
			query: cursor.q,
			count: shown.length,
			sheet: ids.length ? { slot: slots[shown.length], ...sheetLayout() } : null,
			next: next ? slots[slots.length - 1] : null,
			results: shown.map((v, i) => ({
				slot: slots[i],
				id: v.id,
				title: v.title,
				channel: v.channel?.name ?? "",
				duration: v.duration ?? "",
				views: v.views ?? "",
				published: v.published ?? "",
				live: v.live,
				cell: i,
			})),
		},
		300,
	);
}

export function vrcInfo(origin: string): Response {
	return json(
		{
			v: PROTOCOL_VERSION,
			poolSize: POOL_SIZE,
			poolUrl: `${origin}/vrc/p/{slot}`,
			searchPrefix: `${origin}/vrc/search?q=`,
			sheet: sheetLayout(),
		},
		3600,
	);
}

export async function vrcSearch(url: URL, env: Env, ctx: ExecutionContext, opts: ClientOptions): Promise<Response> {
	const cursor = cursorFromUrl(url, opts);
	if (!cursor.q) return fail("Type a search after q=");
	try {
		return await cached(`vrc/search?${JSON.stringify(cursor)}`, ctx, () => buildPage(cursor, env, opts.clientVersion));
	} catch (err) {
		console.error("vrc search failed", err);
		return fail(err instanceof Error ? err.message : "Search failed");
	}
}

export async function vrcSlot(slotText: string, env: Env, ctx: ExecutionContext, origin: string, clientVersion: string): Promise<Response> {
	const slot = Number(slotText);
	if (!Number.isInteger(slot) || slot < 0 || slot >= POOL_SIZE) return text("BetterYTS: no such slot\n", 404);
	const entry = await pool(env).lookup(slot);
	if (!entry) return text("BetterYTS: this slot is empty or expired. Search again.\n", 404);

	switch (entry.kind) {
		case "video":
			return redirect(`https://www.youtube.com/watch?v=${entry.payload}`, 60);
		case "sheet": {
			const ids = JSON.parse(entry.payload) as string[];
			return cached(`vrc/sheet/${ids.join(",")}`, ctx, () => renderSheet(ids, env, origin)).catch((err) => {
				console.error("sheet render failed", err);
				return text("BetterYTS: thumbnails unavailable\n", 503);
			});
		}
		case "page": {
			const cursor = JSON.parse(entry.payload) as PageCursor;
			try {
				return await cached(`vrc/search?${entry.payload}`, ctx, () => buildPage(cursor, env, clientVersion));
			} catch (err) {
				return fail(err instanceof Error ? err.message : "Search failed");
			}
		}
		default:
			return text("BetterYTS: unknown slot type\n", 500);
	}
}
