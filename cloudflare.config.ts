import { bindings, defineConfig, exports } from "cf/config";
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
		exports: {
			// In-world search URL pool (docs/vrchat-protocol.md).
			VrcPool: exports.durableObject({ storage: "sqlite" }),
			// In-world account linking: activation codes and saved libraries (src/vrc/links.ts).
			VrcLinks: exports.durableObject({ storage: "sqlite" }),
			// Watch-party rooms (one object per room code, hibernating WebSockets).
			Room: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			ASSETS: bindings.assets(),
			VRC_POOL: bindings.durableObject({ worker: "betteryts", exportName: "VrcPool" }),
			VRC_LINKS: bindings.durableObject({ worker: "betteryts", exportName: "VrcLinks" }),
			ROOMS: bindings.durableObject({ worker: "betteryts", exportName: "Room" }),
			// Composites in-world thumbnail sheets without spending Worker CPU.
			// dev.remote: the local Images stub can't composite (draw), so dev uses the real service.
			IMAGES: bindings.images({ dev: { remote: true } }),
			// Bump if YouTube ever starts rejecting the WEB client version.
			YT_CLIENT_VERSION: bindings.text("2.20251114.01.00"),
			DEFAULT_HL: bindings.text("en"),
			DEFAULT_GL: bindings.text("US"),
			// Spotify sign-in (src/lib/spotify-auth.ts). Public by design: it's in every consent URL.
			// PKCE, so the app's client secret is never used or stored.
			SPOTIFY_CLIENT_ID: bindings.text("783ca1075f974251a85c57c275adc49e"),
		},
		observability: {
			enabled: true,
		},
	},
});
