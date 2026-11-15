// Shared page chrome: dismissible announcement bar and the mobile navbar menu.

const ANNOUNCE_KEY = "betteryts.announce.v1";

export function initChrome() {
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
