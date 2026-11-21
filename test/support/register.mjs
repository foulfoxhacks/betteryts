// Lets Node tests load Worker code: "cloudflare:workers" resolves to a small stub (workers-stub.mjs).
// Used by `npm test` via `node --import ./test/support/register.mjs`.
import { registerHooks } from "node:module";

const STUB = new URL("./workers-stub.mjs", import.meta.url).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") return { url: STUB, shortCircuit: true };
		return next(specifier, context);
	},
});
