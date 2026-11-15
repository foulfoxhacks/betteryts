// Docs page: shared chrome, sidebar scroll-spy, and copy buttons on code blocks.
import { initChrome } from "./chrome.js";

initChrome();

// Copy buttons
for (const pre of document.querySelectorAll(".doc pre")) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "copy-code";
	btn.textContent = "Copy";
	btn.addEventListener("click", async () => {
		const text = pre.querySelector("code")?.textContent ?? pre.textContent;
		try {
			await navigator.clipboard.writeText(text);
			btn.textContent = "Copied";
		} catch {
			btn.textContent = "Press Ctrl+C";
		}
		setTimeout(() => (btn.textContent = "Copy"), 1500);
	});
	pre.append(btn);
}

// Scroll-spy: highlight the sidebar link for the section in view
const links = new Map(
	[...document.querySelectorAll('.docs-sidebar a[href^="#"]')].map((a) => [a.getAttribute("href").slice(1), a]),
);
const targets = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
let activeId = null;
function setActive(id) {
	if (id === activeId) return;
	activeId = id;
	for (const [key, a] of links) a.classList.toggle("active", key === id);
}
function onScroll() {
	const line = 120;
	let current = targets[0]?.id;
	for (const el of targets) if (el.getBoundingClientRect().top <= line) current = el.id;
	if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = targets.at(-1)?.id;
	setActive(current);
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();
