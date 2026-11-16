// Server-side SEO for the front page: search and watch URLs (/?q=…, /?v=…) are thin,
// per-query pages, so they get a descriptive title, a canonical pointing at the home page,
// and noindex,follow. The bare home page is served untouched.

export const SITE = "https://yts.foulfoxhacks.dev";

export interface PageMeta {
	title: string;
	description: string;
	robots: string;
}

/** Null when the URL is the plain home page (no rewrite needed). */
export function frontPageMeta(url: URL): PageMeta | null {
	const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
	const v = url.searchParams.get("v");
	if (!q && !v) return null;
	const robots = "noindex, follow";
	if (q) {
		return {
			title: `“${q}” — YouTube search without ads · BetterYTS`,
			description: `Ad-free YouTube results for “${q}”, with SponsorBlock, DeArrow and Return YouTube Dislike built in. Paste ${SITE}/search?q=${encodeURIComponent(q)} into a VRChat video player to play the top result.`,
			robots,
		};
	}
	return {
		title: "Watch on BetterYTS — ad-free YouTube with SponsorBlock",
		description: "Watch YouTube with SponsorBlock auto-skip, DeArrow titles and Return YouTube Dislike on BetterYTS.",
		robots,
	};
}

/** Rewrites the home page's <head> for a search/watch URL. */
export function rewriteFrontPage(res: Response, meta: PageMeta): Response {
	const setContent = (value: string) => ({
		element(el: Element) {
			el.setAttribute("content", value);
		},
	});
	const rewritten = new HTMLRewriter()
		.on("title", {
			element(el) {
				el.setInnerContent(meta.title);
			},
		})
		.on('meta[name="description"]', setContent(meta.description))
		.on('meta[name="robots"]', setContent(meta.robots))
		.on('meta[property="og:title"]', setContent(meta.title))
		.on('meta[name="twitter:title"]', setContent(meta.title))
		.on('meta[property="og:description"]', setContent(meta.description))
		.on('meta[name="twitter:description"]', setContent(meta.description))
		.transform(res);
	const out = new Response(rewritten.body, rewritten);
	out.headers.set("X-Robots-Tag", meta.robots);
	out.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
	return out;
}
