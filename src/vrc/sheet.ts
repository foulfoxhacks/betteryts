// Thumbnail sheet for in-world search: one JPEG holding every result's thumbnail, because
// VRChat only allows one image download per 5 seconds and can't follow redirects.
// Composited by the Cloudflare Images binding, so it costs no Worker CPU.

// Cells match YouTube's mqdefault thumbnails (320x180), so no per-cell resize is needed.
export const SHEET = { cols: 4, rows: 3, cellW: 320, cellH: 180 } as const;
export const SHEET_W = SHEET.cols * SHEET.cellW; // 1280
export const SHEET_H = SHEET.rows * SHEET.cellH; // 540
/** The Images API allows 10 transforms per chain; composite in passes of this many draws. */
const DRAWS_PER_PASS = 6;
export const SHEET_BG_PATH = "/vrc/sheet-bg.png";

export function sheetLayout() {
	return { ...SHEET, width: SHEET_W, height: SHEET_H };
}

/** Pixel offset of a cell, row-major from the top-left. */
export function cellOffset(index: number): { left: number; top: number } {
	return {
		left: (index % SHEET.cols) * SHEET.cellW,
		top: Math.floor(index / SHEET.cols) * SHEET.cellH,
	};
}

export async function renderSheet(ids: string[], env: Env, origin: string): Promise<Response> {
	const bg = await env.ASSETS.fetch(new URL(SHEET_BG_PATH, origin));
	if (!bg.ok || !bg.body) throw new Error("Sheet background asset missing");

	// mqdefault is exactly 320x180 (16:9, no letterbox bars).
	const thumbs = await Promise.all(
		ids.slice(0, SHEET.cols * SHEET.rows).map(async (id) => {
			try {
				const r = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`, {
					cf: { cacheTtl: 86400, cacheEverything: true },
				} as RequestInit);
				return r.ok && r.body ? r.body : null;
			} catch {
				return null;
			}
		}),
	);

	const cells = thumbs.flatMap((body, i) => (body ? [{ body, at: cellOffset(i) }] : []));
	let base: ReadableStream<Uint8Array> = bg.body;
	// Every pass but the last outputs lossless PNG that the next pass draws on.
	for (let i = 0; i < Math.max(cells.length, 1); i += DRAWS_PER_PASS) {
		let canvas = env.IMAGES.input(base);
		for (const c of cells.slice(i, i + DRAWS_PER_PASS)) canvas = canvas.draw(env.IMAGES.input(c.body), c.at);
		const last = i + DRAWS_PER_PASS >= cells.length;
		if (last) {
			const out = await canvas.output({ format: "image/jpeg", quality: 82 });
			base = out.image();
			break;
		}
		base = (await canvas.output({ format: "image/png" })).image();
	}
	const out = { response: () => new Response(base) };
	// Re-wrap so headers stay mutable (the edge cache helper adds X-Cache).
	return new Response(out.response().body, {
		headers: {
			"Content-Type": "image/jpeg",
			"Cache-Control": "public, max-age=3600, s-maxage=86400",
			"X-Robots-Tag": "noindex",
			"Access-Control-Allow-Origin": "*",
		},
	});
}
