import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	environments: {
		client: {
			build: {
				rollupOptions: {
					// Two static pages: the search front page and the API docs.
					input: { main: "index.html", docs: "docs.html" },
				},
			},
		},
	},
});
