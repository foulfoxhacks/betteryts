// Plugin categories, community plugins and their sandbox.
//
// Built-in plugins are grouped into categories, each with a whole-category switch: a plugin runs
// only if both it and its category are on. Community plugins (installed from a JSON manifest)
// may only join categories marked `community`, and only ask for that category's permissions.
// Their code runs in /plugin-sandbox: an <iframe sandbox="allow-scripts"> (opaque origin, so no
// cookies, storage or DOM of this site) that runs the code in a Worker under a CSP with no
// network. The rules match BetterYTS Music's core/src/plugins.rs, so a manifest that installs
// on one installs on the other.

export const CATEGORIES = [
	{ id: "Playback", name: "Playback", description: "What plays and when. Built-in plugins only.", community: false, permissions: [] },
	{ id: "Player", name: "Player", description: "Extras shown with the video. Community plugins here can see what's playing and show a text panel.", community: true, permissions: ["nowPlaying", "panel"] },
	{ id: "Look", name: "Look", description: "Colours and style. Community plugins here can change the accent colours.", community: true, permissions: ["palette"] },
	{ id: "BetterYTS", name: "BetterYTS", description: "Rooms, VRChat and the rest of the ecosystem. Built-in plugins only.", community: false, permissions: [] },
];

/** The site's built-in plugins (each one's on/off lives in settings[id]). */
export const BUILTIN = [
	{ id: "sponsorblock", category: "Playback", name: "SponsorBlock", description: "Skip sponsors, intros, outros and non-music parts. Choose categories below." },
	{ id: "sleep", category: "Playback", name: "Sleep timer", description: "Stop playback after a while or at the end of the video." },
	{ id: "lyrics", category: "Player", name: "Synced lyrics", description: "Time-synced lyrics from LRCLIB next to music videos." },
	{ id: "dislikes", category: "Player", name: "Return YouTube Dislike", description: "Like and dislike counts under the video." },
	{ id: "dearrow", category: "Look", name: "DeArrow", description: "Community titles and thumbnails instead of clickbait." },
	{ id: "vrchat", category: "BetterYTS", name: "VRChat bridge", description: "Copy-for-VRChat, room and ProTV playlist links." },
];

export const PERMISSIONS = {
	nowPlaying: "See the title, channel and position of what's playing",
	panel: "Show a short text panel next to the video",
	palette: "Change the accent colours",
};

export const PALETTE_KEYS = ["accent", "hot"];
export const MAX_COMMUNITY = 10;
export const MAX_CODE_BYTES = 20_000;

// ---- Manifest validation ----

function clean(m, key, max) {
	const raw = m[key];
	if (raw == null) return "";
	if (typeof raw !== "string") throw new Error(`\`${key}\` must be text`);
	// eslint-disable-next-line no-control-regex
	const t = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
	if ([...t].length > max) throw new Error(`\`${key}\` is longer than ${max} characters`);
	return t;
}

/** Checks a manifest (JSON text or an object). Returns the plugin, or throws with a reason. */
export function validateManifest(input) {
	let m = input;
	if (typeof input === "string") {
		if (input.length > MAX_CODE_BYTES + 4000) throw new Error("That manifest is too big");
		try {
			m = JSON.parse(input);
		} catch {
			throw new Error("That isn't a plugin manifest (expected JSON)");
		}
	}
	if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("That isn't a plugin manifest (expected a JSON object)");

	const id = clean(m, "id", 32);
	if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(id)) throw new Error("`id` must be 3-32 characters: lowercase letters, digits and dashes");
	if (BUILTIN.some((p) => p.id === id) || ["background", "radio", "together"].includes(id)) throw new Error(`\`${id}\` is a built-in plugin`);
	const name = clean(m, "name", 40);
	if (!name) throw new Error("`name` is required");
	const category = clean(m, "category", 20);
	const cat = CATEGORIES.find((c) => c.id === category);
	if (!cat) throw new Error(`Unknown category \`${category}\``);
	if (!cat.community) {
		const allowed = CATEGORIES.filter((c) => c.community).map((c) => c.id);
		throw new Error(`Community plugins can't be in ${cat.name} (allowed: ${allowed.join(", ")})`);
	}
	if (!Array.isArray(m.permissions)) throw new Error("`permissions` must be a list");
	const permissions = [];
	for (const p of m.permissions) {
		if (typeof p !== "string") throw new Error("`permissions` must be a list of names");
		if (!cat.permissions.includes(p)) throw new Error(`A ${cat.name} plugin can't ask for \`${p}\` (allowed: ${cat.permissions.join(", ")})`);
		if (!permissions.includes(p)) permissions.push(p);
	}
	if (!permissions.length) throw new Error("`permissions` is empty: the plugin couldn't do anything");

	if (m.code != null && typeof m.code !== "string") throw new Error("`code` must be text");
	const code = m.code ?? "";
	const runs = permissions.includes("nowPlaying") || permissions.includes("panel");
	if (runs && !code.trim()) throw new Error("This plugin needs `code`");
	if (!runs && code) throw new Error("Only Player plugins can run code");
	if (new TextEncoder().encode(code).length > MAX_CODE_BYTES) throw new Error(`\`code\` is over ${MAX_CODE_BYTES / 1000} KB`);

	const palette = {};
	if (m.palette != null) {
		if (typeof m.palette !== "object" || Array.isArray(m.palette)) throw new Error("`palette` must be an object");
		for (const [k, c] of Object.entries(m.palette)) {
			if (!PALETTE_KEYS.includes(k)) throw new Error(`\`palette\` can only set ${PALETTE_KEYS.join(", ")}`);
			if (typeof c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error(`\`palette.${k}\` must be a colour like #ff8800`);
			palette[k] = c.toLowerCase();
		}
	}
	const wantsPalette = permissions.includes("palette");
	if (wantsPalette && !Object.keys(palette).length) throw new Error("A Look plugin needs a `palette`");
	if (!wantsPalette && Object.keys(palette).length) throw new Error("`palette` needs the `palette` permission");

	return { id, name, version: clean(m, "version", 16), author: clean(m, "author", 40), description: clean(m, "description", 200), category, permissions, code, palette };
}

// ---- Installed community plugins (this browser only) ----

const KEY = "betteryts.community-plugins.v1";

export const community = {
	all() {
		try {
			const list = JSON.parse(localStorage.getItem(KEY) || "[]");
			// Re-check on load: storage is just as untrusted as the manifest was.
			return Array.isArray(list)
				? list.flatMap((p) => {
						try {
							return [{ ...validateManifest(p), enabled: p.enabled !== false }];
						} catch {
							return [];
						}
					})
				: [];
		} catch {
			return [];
		}
	},
	save(list) {
		try {
			localStorage.setItem(KEY, JSON.stringify(list));
		} catch {
			/* storage blocked: community plugins last until the page closes */
		}
	},
	/** Installs or updates (by id); returns the plugin. Throws if the manifest is refused. */
	install(manifest) {
		const p = validateManifest(manifest);
		const list = community.all();
		const i = list.findIndex((x) => x.id === p.id);
		if (i < 0 && list.length >= MAX_COMMUNITY) throw new Error(`You can have up to ${MAX_COMMUNITY} community plugins`);
		if (i >= 0) list[i] = { ...p, enabled: true };
		else list.push({ ...p, enabled: true });
		community.save(list);
		return p;
	},
	setEnabled(id, on) {
		community.save(community.all().map((p) => (p.id === id ? { ...p, enabled: on } : p)));
	},
	remove(id) {
		community.save(community.all().filter((p) => p.id !== id));
	},
};

// ---- Switches ----

export function categoryOn(settings, id) {
	return settings.categories?.[id] !== false;
}

/** True if a built-in plugin should run: it and its category are both on. */
export function builtinOn(settings, id) {
	const p = BUILTIN.find((x) => x.id === id);
	return !!p && !!settings[id] && categoryOn(settings, p.category);
}

/** Community plugins that should run now. */
export function activeCommunity(settings) {
	return community.all().filter((p) => p.enabled && categoryOn(settings, p.category));
}

// ---- Look: palette ----

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

/** Applies active Look plugins' colours over the theme (later plugins win), or clears them. */
export function applyPalette(plugins) {
	const merged = Object.assign({}, ...plugins.filter((p) => p.permissions.includes("palette")).map((p) => p.palette));
	const root = document.documentElement.style;
	if (merged.accent) {
		root.setProperty("--accent-rgb", hexToRgb(merged.accent));
		root.setProperty("--primary", merged.accent);
	} else {
		root.removeProperty("--accent-rgb");
		root.removeProperty("--primary");
	}
	if (merged.hot) root.setProperty("--hot-rgb", hexToRgb(merged.hot));
	else root.removeProperty("--hot-rgb");
}

// ---- Player: sandboxed code ----

/** One community plugin running in its own sandbox frame. */
export class Sandbox {
	constructor(plugin, { onPanel, onError }) {
		this.plugin = plugin;
		this.ready = false;
		this.pending = null;
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("aria-hidden", "true");
		frame.setAttribute("tabindex", "-1");
		frame.title = `Plugin sandbox: ${plugin.name}`;
		frame.hidden = true;
		frame.src = "/plugin-sandbox";
		this.frame = frame;
		this.listener = (e) => {
			// Only this frame's messages, and only the shapes the sandbox may send.
			if (e.source !== frame.contentWindow) return;
			const m = e.data;
			if (!m || typeof m !== "object") return;
			if (m.t === "ready" && !this.ready) {
				this.ready = true;
				this.post({ t: "start", code: plugin.code, permissions: plugin.permissions });
				if (this.pending) this.post(this.pending);
			} else if (m.t === "panel" && plugin.permissions.includes("panel")) onPanel?.(String(m.text ?? "").slice(0, 500));
			else if (m.t === "error") onError?.(String(m.text ?? "").slice(0, 200));
		};
		window.addEventListener("message", this.listener);
		document.body.append(frame);
	}

	post(msg) {
		// The sandbox has an opaque origin, so "*" is the only target that reaches it; what's sent
		// is limited to the plugin's permissions.
		this.frame.contentWindow?.postMessage(msg, "*");
	}

	nowPlaying(data) {
		if (!this.plugin.permissions.includes("nowPlaying")) return;
		const msg = { t: "nowPlaying", data };
		if (this.ready) this.post(msg);
		else this.pending = msg;
	}

	destroy() {
		window.removeEventListener("message", this.listener);
		this.frame.remove();
	}
}
