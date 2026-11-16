import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "betteryts",
		compatibilityDate: "2026-11-13",
		entrypoint,
		// Front page + docs are static assets (built by Vite from index.html / docs.html / public/).
		// Anything that isn't an asset (/search, /api/*, /lofi hip hop, …) falls through to the Worker.
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "none",
			// The front page goes through the Worker so search URLs (/?q=…) get their own
			// <title>, canonical and noindex tags. Every other asset is served directly.
			runWorkerFirst: ["/"],
		},
		domains: ["yts.foulfoxhacks.dev"],
		env: {
			ASSETS: bindings.assets(),
			// Bump if YouTube ever starts rejecting the WEB client version.
			YT_CLIENT_VERSION: bindings.text("2.20251114.01.00"),
			DEFAULT_HL: bindings.text("en"),
			DEFAULT_GL: bindings.text("US"),
		},
		observability: {
			enabled: true,
		},
	},
});
