import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	environments: {
		client: {
			build: {
				rollupOptions: {
					// Static pages: search front page, API docs, visual site map.
					input: { main: "index.html", docs: "docs.html", sitemap: "sitemap.html" },
				},
			},
		},
	},
});
