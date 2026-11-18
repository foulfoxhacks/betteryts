// Subscriptions feed helpers. Pure functions (no DOM), so Node tests can import them.

const UNIT_SECONDS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };

/**
 * YouTube only gives relative dates ("3 days ago", "Streamed 2 weeks ago"). Turns them into an
 * approximate age in seconds for sorting; unknown text sorts last.
 */
export function ageSeconds(text) {
	const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(String(text || ""));
	return m ? Number(m[1]) * UNIT_SECONDS[m[2].toLowerCase()] : Number.POSITIVE_INFINITY;
}

/**
 * Merges each channel's latest uploads into one feed, newest first. Shorts and upcoming
 * premieres are left out. Videos keep their order within a channel when ages tie.
 * @param {{ channel: object, results: object[] }[]} pages
 */
export function mergeFeed(pages, limit = 60) {
	const all = [];
	for (const { channel, results } of pages) {
		(results || []).forEach((v, i) => {
			if (!v || v.type !== "video" || v.upcoming) return;
			all.push({ v: { ...v, channel: v.channel || channel }, age: ageSeconds(v.published), i });
		});
	}
	all.sort((a, b) => a.age - b.age || a.i - b.i);
	const seen = new Set();
	const out = [];
	for (const { v } of all) {
		if (seen.has(v.id)) continue;
		seen.add(v.id);
		out.push(v);
		if (out.length >= limit) break;
	}
	return out;
}

/** Runs `fn` over `items` with at most `n` in flight. Failures become `null`. */
export async function mapLimit(items, n, fn) {
	const out = new Array(items.length).fill(null);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				try {
					out[i] = await fn(items[i], i);
				} catch {
					out[i] = null;
				}
			}
		}),
	);
	return out;
}
