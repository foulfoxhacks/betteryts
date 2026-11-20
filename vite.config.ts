import { cloudflare } from "@cloudflare/vite-plugin";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** Short commit of this build, shown in the footer and /api/health ("dev" outside git). */
function buildId(): string {
	try {
		const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() ? "+" : "";
		return sha + dirty;
	} catch {
		return "dev";
	}
}

export default defineConfig({
	plugins: [cloudflare()],
	define: { __BUILD__: JSON.stringify(buildId()) },
	environments: {
		client: {
			build: {
				rollupOptions: {
					// Static pages: search front page, API docs, visual site map.
					input: { main: "index.html", docs: "docs.html", sitemap: "sitemap.html", ecosystem: "ecosystem.html", privacy: "privacy.html" },
				},
			},
		},
	},
});
