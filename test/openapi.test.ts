// The OpenAPI document covers every endpoint /api lists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openapi } from "../src/lib/openapi.ts";

test("openapi: valid shape and complete", () => {
	const doc = openapi("https://yts.foulfoxhacks.dev", "1.1.0");
	assert.equal(doc.openapi, "3.1.0");
	assert.equal(doc.info.version, "1.1.0");
	const paths = Object.keys(doc.paths);
	// Every "GET /path" in the /api index (src/index.ts) has a path here.
	const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	const listed = [...index.matchAll(/"GET (\/[^"?\s<]*)/g)].map((m) => m[1].replace(/\{id\|@handle\}/, "{ref}"))
		.filter((l) => l !== "/"); // "GET /<query>" is the u2b-style catch-all, not a fixed path
	for (const l of listed) {
		const ok = paths.some((p) => p === l || p.replace(/\{[^}]+\}/g, "{x}") === l.replace(/\{[^}]+\}/g, "{x}") || l.startsWith(p + "?") || (l.includes("|") && l.startsWith(p)));
		assert.ok(ok, `/api lists ${l} but openapi.ts doesn't describe it`);
	}
	for (const [path, item] of Object.entries(doc.paths)) {
		const params = (item as { get: { parameters: { in: string; name: string }[] } }).get.parameters;
		for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) assert.ok(params.some((x) => x.in === "path" && x.name === name), `${path} declares {${name}}`);
	}
});
