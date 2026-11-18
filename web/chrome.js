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
