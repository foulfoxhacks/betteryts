import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Separate from the main BetterYTS Worker: its own host, so YouTube scraping traffic and its
// failures never affect yts.foulfoxhacks.dev (or how that site is crawled).
export default defineConfig({
	worker: {
		name: "betteryts-youtube-chat",
		compatibilityDate: "2026-11-13",
		entrypoint,
		domains: ["ytchat.foulfoxhacks.dev"],
		workersDev: false,
		observability: { enabled: true },
	},
});
