// Shared page chrome: dismissible announcement bar and the mobile navbar menu.

const ANNOUNCE_KEY = "betteryts.announce.v1";
const THEME_KEY = "betteryts.theme";

/** Same two palettes as BetterYTS Music (styles.css has the tokens). */
export const THEMES = [
	{ id: "ember", name: "Ember", note: "akasammythepuppy", swatches: ["#ffc857", "#f0c890", "#9b6cff", "#ff681e", "#ff8dd0"], bg: "#120c08" },
	{ id: "mello", name: "Mello", note: "Mello Zone", swatches: ["#ef8fcb", "#a8c7ff", "#7637ff", "#3f86ff", "#f4b8e4"], bg: "#101020" },
];

export function currentTheme() {
	try {
		return localStorage.getItem(THEME_KEY) === "mello" ? "mello" : "ember";
	} catch {
		return "ember";
	}
}

/** Mello is always dark; Ember follows the system light/dark setting as before. */
export function applyTheme(id = currentTheme()) {
	const root = document.documentElement;
	root.dataset.palette = id;
	if (id === "mello") root.dataset.theme = "dark";
	else delete root.dataset.theme;
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", id === "mello" ? "#070712" : "#050302");
}

export function setTheme(id) {
	try {
		localStorage.setItem(THEME_KEY, id);
	} catch {
		/* storage blocked: applies for this page only */
	}
	applyTheme(id);
}

// Other tabs switching theme.
addEventListener("storage", (e) => e.key === THEME_KEY && applyTheme());

export function initChrome() {
	applyTheme();
	fillVersions();
	const bar = document.getElementById("announce");
	if (bar) {
		let dismissed = false;
		try {
			dismissed = localStorage.getItem(ANNOUNCE_KEY) === "1";
		} catch {
			/* storage blocked: just show it */
		}
		bar.hidden = dismissed;
		bar.querySelector(".announce-close")?.addEventListener("click", () => {
			bar.hidden = true;
			try {
				localStorage.setItem(ANNOUNCE_KEY, "1");
			} catch {
				/* ignore */
			}
		});
	}

	const navbar = document.getElementById("navbar");
	const menuBtn = document.getElementById("menu-btn");
	if (navbar && menuBtn) {
		const setOpen = (open) => {
			navbar.classList.toggle("open", open);
			menuBtn.setAttribute("aria-expanded", String(open));
		};
		menuBtn.addEventListener("click", () => setOpen(!navbar.classList.contains("open")));
		document.addEventListener("click", (e) => {
			if (e.target.closest(".nav-links a, .docs-sidebar a")) setOpen(false);
		});
		document.addEventListener("keydown", (e) => e.key === "Escape" && setOpen(false));
	}
}

/**
 * Footer (and /ecosystem) versions: the page ships with the numbers at build time; this swaps in
 * the live ones from /api/ecosystem (VRChat packages come straight from the VPM listing).
 */
/** /ecosystem: the Music app's download button and checksum, from the in-app updater's manifest. */
function fillAppDownload() {
	const box = document.querySelector("[data-app-download]");
	if (!box) return;
	fetch("/app/update.json", { cache: "no-cache" })
		.then((r) => (r.ok ? r.json() : null))
		.then((m) => {
			const url = m?.apk?.url;
			if (typeof url !== "string" || !url.startsWith(`${location.origin}/app/`) && !url.startsWith("https://yts.foulfoxhacks.dev/app/")) return;
			const a = box.querySelector("[data-app-apk]");
			a.href = new URL(url).pathname;
			a.textContent = `Download APK · v${m.versionName} · ${(m.apk.size / 1048576).toFixed(1)} MB`;
			box.hidden = false;
			const sha = document.querySelector("[data-app-sha]");
			sha.textContent = `SHA-256 ${m.apk.sha256} · signed by ${String(m.signerSha256).slice(0, 16)}… · Android 8+. After this one, the app updates itself.`;
			sha.hidden = false;
		})
		.catch(() => {
			/* no published build yet: the button stays hidden */
		});
}

function fillVersions() {
	fillAppDownload();
	const build = typeof __BUILD__ === "string" ? __BUILD__ : "dev";
	for (const el of document.querySelectorAll("[data-build]")) el.textContent = build;
	if (!document.querySelector("[data-version], [data-packages]")) return;
	fetch("/api/ecosystem")
		.then((r) => (r.ok ? r.json() : null))
		.then((eco) => {
			if (!eco?.projects) return;
			for (const p of eco.projects) {
				for (const el of document.querySelectorAll(`[data-version="${p.id}"]`)) {
					if (p.version) el.textContent = `v${p.version}`;
				}
				const list = p.packages?.length ? document.querySelector("[data-packages]") : null;
				if (list && p.id === "vrchat") {
					list.replaceChildren(
						...p.packages.map((pkg) => {
							const li = document.createElement("li");
							const b = document.createElement("b");
							b.textContent = pkg.name;
							const code = document.createElement("code");
							code.textContent = `${pkg.id} · v${pkg.version}`;
							li.append(b, " ", code);
							return li;
						}),
					);
				}
			}
		})
		.catch(() => {
			/* offline: the build-time numbers stay */
		});
}
