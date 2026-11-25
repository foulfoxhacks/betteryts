// Automations: simple chain editor ("when X, show text / wait"). Advanced imported chains are kept
// as-is and listed read-only. All text is set with textContent. Saving goes through chains_save
// (validated in Rust); the engine reloads immediately.
"use strict";
(() => {
	const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
	const $ = (id) => document.getElementById(id);
	const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text !== undefined ? { textContent: text } : {});
	const KINDS = { gift: "Gift", follow: "Follow", cheer: "Cheer (bits)", raid: "Raid", share: "Share", subscribe: "Sub", like: "Like" };
	let chains = [];
	let steps = [];

	// A chain the simple editor can show: only `do console text` and `delay` steps.
	const WHERE = { console: "show", "overlay.alert": "alert", "twitch.chat": "say in chat", "obs.scene": "OBS scene", "obs.text": "OBS text" };
	const simple = (c) => c.steps.every((s) => s.delay || (s.do && WHERE[s.do.output] && s.do.command.text !== undefined));
	const minAmount = (c) => (c.trigger.when && c.trigger.when.ge ? c.trigger.when.ge[1].const : 0);

	function timeline(list) {
		let t = 0;
		const out = [];
		for (const s of list) {
			if (s.delay) t += s.delay.ms;
			else if (s.do) out.push(`${(t / 1000).toFixed(1)} s — ${WHERE[s.do.output] || s.do.output} “${s.do.command.text}”`);
		}
		return out;
	}

	async function load() {
		chains = JSON.parse(await invoke("chains_get")).chains;
		render();
	}
	async function save() {
		const n = await invoke("chains_save", { json: JSON.stringify({ schema: 1, chains }) });
		toast(`${n} automation${n === 1 ? "" : "s"} saved and active.`);
		render();
	}

	function render() {
		const box = $("chain-list");
		if (!chains.length) return box.replaceChildren(el("p", "empty", "No automations yet. Make one below."));
		box.replaceChildren(
			...chains.map((c, i) => {
				const row = el("article", "item");
				const mid = el("div");
				mid.append(el("div", "t", c.name));
				const when = `${c.trigger.kinds.map((k) => KINDS[k] || k).join(", ")}${c.trigger.platforms.length ? ` on ${c.trigger.platforms.join(", ")}` : ""}${minAmount(c) ? ` ≥ ${minAmount(c)}` : ""}`;
				mid.append(el("div", "s", simple(c) ? `When: ${when} · ${timeline(c.steps).join(" · ")}` : `When: ${when} · advanced chain (edit by import)`));
				const side = el("div", "side-col");
				const toggle = el("button", `btn small ${c.enabled ? "primary" : ""}`, c.enabled ? "On" : "Off");
				toggle.onclick = () => run(async () => ((c.enabled = !c.enabled), await save()));
				const del = el("button", "btn small", "Delete");
				del.onclick = () => run(async () => (confirm(`Delete “${c.name}”?`) && (chains.splice(i, 1), await save())));
				side.append(toggle, del);
				row.append(el("div", "noart"), mid, side);
				return row;
			}),
		);
	}

	function renderSteps() {
		$("step-list").replaceChildren(
			...steps.map((s, i) => {
				const li = el("li", "", s.delay ? `Wait ${s.delay.ms} ms` : `${WHERE[s.do.output]} “${s.do.command.text}”`);
				const x = el("button", "btn small", "×");
				x.onclick = () => ((steps.splice(i, 1), renderSteps()));
				li.append(" ", x);
				return li;
			}),
		);
		$("chain-preview").textContent = steps.length ? timeline(steps).join("\n") || "(only waits)" : "Add steps to see the timeline.";
	}

	$("add-text").onclick = () => {
		const t = $("step-text").value.trim().slice(0, 200);
		if (t) steps.push({ do: { output: $("step-output").value, command: { text: t } } }), ($("step-text").value = ""), renderSteps();
	};
	$("add-wait").onclick = () => {
		const ms = Math.min(600000, Math.max(0, Math.round(Number($("step-wait").value) || 0)));
		if (ms) steps.push({ delay: { ms } }), renderSteps();
	};
	$("chain-create").onclick = () =>
		run(async () => {
			const name = $("chain-name").value.trim().slice(0, 60);
			if (!name || !steps.length) return toast("Give the automation a name and at least one step.");
			const min = Math.max(0, Number($("chain-min").value) || 0);
			const platform = $("chain-platform").value;
			chains.push({
				id: `c${Date.now().toString(36)}`,
				name,
				enabled: true,
				trigger: { kinds: [$("chain-kind").value], platforms: platform ? [platform] : [], when: min ? { ge: [{ field: "amount" }, { const: min }] } : "always" },
				steps,
				cooldown_ms: Math.round((Number($("chain-cooldown").value) || 0) * 1000),
				per_user_cooldown_ms: 0,
			});
			steps = [];
			$("chain-name").value = "";
			renderSteps();
			await save();
		});

	// Navigation between Get Live and Automations.
	for (const a of document.querySelectorAll("[data-view]")) {
		a.onclick = (e) => {
			e.preventDefault();
			for (const n of document.querySelectorAll("[data-view]")) n.classList.toggle("active", n === a);
			const auto = a.dataset.view === "automations";
			$("automations").hidden = !auto;
			$("live-view").hidden = auto;
			document.querySelector(".top h1").textContent = auto ? "Automations" : "Get Live";
			if (auto) run(load);
		};
	}
	renderSteps();
})();
