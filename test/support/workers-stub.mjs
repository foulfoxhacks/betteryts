// Stand-in for the "cloudflare:workers" module in Node tests.
export class DurableObject {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
/** The Worker's env; tests fill it in (bindings, text vars) before calling the code under test. */
export const env = {};
