// BetterYTS Stream Desktop: Get Live console. Talks only to the Rust commands in src/main.rs.
// All request data (titles, names, input) is untrusted: it is written with textContent, never HTML.
"use strict";

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text !== undefined) n.textContent = text;
	return n;
};

const KIND = { song: "Song", video: "Video", shoutout: "Shoutout" };
const LABELS = { queued: "Queued", pending_approval: "Needs approval", approved: "Approved", dispatching: "Sending to player", playing: "Playing", completed: "Completed", rejected: "Rejected", skipped: "Skipped", failed: "Failed", cancelled: "Removed", resolving: "Looking up", received: "Received" };
const filters = { active: "all", history: "all" };
let settings = null;
let last = null;
let pollTimer = null;
let busy = false;

function toast(message) {
	const t = $("toast");
	t.textContent = String(message).slice(0, 300);
	t.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => (t.hidden = true), 5000);
}

async function run(fn) {
	if (busy) return;
	busy = true;
	try {
		await fn();
	} catch (e) {
		toast(typeof e === "string" ? e : "Something went wrong. Try again.");
	} finally {
		busy = false;
	}
}

// ---- profile ----
function initials(name) {
	return (name || "B").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "B";
}
function showProfile() {
	const p = settings.profile;
	$("name").value = p.displayName;
	$("handle").value = p.handle;
	$("venue").value = p.venue;
	$("avatar").textContent = initials(p.displayName);
	$("t-discord").checked = !!settings.discord?.enabled;
	$("t-tiktok").checked = !!settings.tikfinity?.enabled;
	$("t-replies").checked = !!settings.twitch?.replies;
}
let profileTimer = null;
for (const id of ["name", "handle", "venue"]) {
	$(id).addEventListener("input", () => {
		$("avatar").textContent = initials($("name").value);
		clearTimeout(profileTimer);
		profileTimer = setTimeout(async () => {
			try {
				settings = await invoke("save_profile", { profile: { displayName: $("name").value, handle: $("handle").value, venue: $("venue").value } });
			} catch (e) {
				toast(e);
			}
		}, 600);
	});
}

// ---- session timer (local start time per session code) ----
function liveSinceKey() {
	return `bys.liveSince.${settings.sessionCode}`;
}
function tickClock() {
	if (!settings?.sessionCode) return;
	const since = Number(localStorage.getItem(liveSinceKey())) || Date.now();
	const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
	const pad = (n) => String(n).padStart(2, "0");
	const clock = $("clock");
	clock.replaceChildren(pad(Math.floor(s / 3600)), el("small", "", "h"), " : ", pad(Math.floor((s % 3600) / 60)), el("small", "", "m"), " : ", pad(s % 60), el("small", "", "s"));
}

// ---- rendering ----
function itemNode(r, historyList) {
	const kind = KIND[r.kind] ? r.kind : "song";
	const node = el("article", `item ${r.state} k-${kind}`);
	const thumb = r.media?.thumbnail || (r.media?.id ? `https://i.ytimg.com/vi/${encodeURIComponent(r.media.id)}/mqdefault.jpg` : "");
	if (thumb.startsWith("https://i.ytimg.com/")) {
		const img = el("img");
		img.src = thumb;
		img.alt = "";
		img.loading = "lazy";
		node.append(img);
	} else node.append(el("div", "noart"));
	const mid = el("div");
	const title = el("div", "t", kind === "shoutout" ? r.input : r.media?.title || r.input || "Request");
	title.append(el("span", `kind ${kind}`, KIND[kind]));
	mid.append(title);
	mid.append(el("div", "s", [r.media?.creator, r.requester && `requested by ${r.requester}`, r.platform].filter(Boolean).join(" · ")));
	if (historyList && r.message && r.state !== "completed") mid.append(el("div", "s", r.message));
	node.append(mid);
	const side = el("div", "side-col");
	side.append(el("span", `tag ${r.state}`, LABELS[r.state] || r.state));
	if (!historyList) {
		if (r.state === "pending_approval") {
			side.append(button("Approve", "primary", () => act("approve", r.id)));
			side.append(button("Reject", "", () => act("reject", r.id)));
		} else if (["queued", "dispatching", "playing"].includes(r.state)) {
			side.append(button("Mark as completed", "", () => act("complete", r.id)));
		}
	}
	node.append(side);
	return node;
}
function button(text, cls, onClick) {
	const b = el("button", `btn small ${cls}`, text);
	b.type = "button";
	b.addEventListener("click", onClick);
	return b;
}
function renderList(id, rows, historyList) {
	const f = filters[id];
	const shown = rows.filter((r) => f === "all" || (id === "active" ? (r.kind || "song") === f : r.state === f));
	const box = $(id);
	if (!shown.length) {
		box.replaceChildren(el("p", "empty", historyList ? "Nothing here yet." : "No requests in the queue."));
		return;
	}
	box.replaceChildren(...shown.map((r) => itemNode(r, historyList)));
}
function render(q) {
	last = q;
	$("s-received").textContent = q.stats.received;
	$("s-accepted").textContent = q.stats.accepted;
	$("s-rejected").textContent = q.stats.rejected;
	$("s-completed").textContent = q.stats.completed;
	const kinds = q.kinds || { song: true, video: false, shoutout: false };
	$("t-songs").checked = kinds.song;
	$("t-videos").checked = kinds.video;
	$("t-shoutouts").checked = kinds.shoutout;
	$("pause").textContent = q.intake ? "Pause" : "Go live";
	$("conn").textContent = q.destinationOnline ? "Connected · player online" : "Connected · no player connected";
	$("session-pill").textContent = `${q.code} · ${q.command}`;
	$("session-pill").hidden = false;
	renderList("active", q.active, false);
	renderList("history", q.history, true);
}

for (const group of document.querySelectorAll(".filters")) {
	group.addEventListener("click", (e) => {
		const b = e.target.closest("button");
		if (!b) return;
		for (const x of group.querySelectorAll("button")) x.classList.toggle("on", x === b);
		filters[group.dataset.list] = b.dataset.f;
		if (last) render(last);
	});
}

// ---- Pear Desktop playback ----
const PLAYER = { off: "Pear Desktop: off", not_authorized: "Pear Desktop: authorize again", unreachable: "Pear Desktop: not running", ready: "Pear Desktop: ready" };
let playerOn = false;
async function refreshPlayer() {
	try {
		const p = await invoke("player_status");
		playerOn = p.state !== "off" && p.state !== "";
		$("player-state").textContent = PLAYER[p.state] || "Pear Desktop: starting";
		const now = p.nowPlaying ? `Now playing: ${p.nowPlaying.title}${p.nowPlaying.artist ? ` — ${p.nowPlaying.artist}` : ""}` : "";
		$("player-now").textContent = now || p.lastResult || "";
		$("pear-btn").textContent = playerOn && p.state !== "not_authorized" ? "Disconnect" : "Connect Pear Desktop";
	} catch {
		/* keep the last status */
	}
}
$("pear-btn").addEventListener("click", () =>
	run(async () => {
		if (playerOn && $("pear-btn").textContent === "Disconnect") {
			await invoke("pear_disconnect");
		} else {
			toast("Open Pear Desktop and click Allow for “betteryts-stream” (you have two minutes).");
			await invoke("pear_connect");
			toast("Pear Desktop connected. Approved requests now play there.");
		}
		await refreshPlayer();
	}),
);

$("t-discord").addEventListener("change", (e) =>
	run(async () => {
		settings = await invoke("set_discord", { enabled: e.target.checked });
		toast(settings.discord.enabled ? "Discord presence on. Viewer names stay hidden." : "Discord presence off.");
	}),
);

// ---- Twitch ----
let twitchState = "off";
async function refreshTwitch() {
	try {
		const t = await invoke("twitch_status");
		twitchState = t.state || "off";
		const info = $("twitch-info");
		if (twitchState === "waiting_for_approval" && t.userCode) {
			$("twitch-state").textContent = "Twitch: waiting for approval";
			info.replaceChildren("Enter ", el("span", "code", t.userCode), " at twitch.tv/activate");
		} else {
			$("twitch-state").textContent =
				twitchState === "connected" ? `Twitch: @${t.login}${typeof t.viewers === "number" ? ` · ${t.viewers} watching` : ""}` : twitchState === "connecting" ? "Twitch: connecting…" : twitchState === "error" ? "Twitch: problem" : "Twitch: off";
			info.textContent = (twitchState === "error" ? t.error : t.lastEvent) || "";
		}
		$("twitch-btn").textContent = ["connected", "connecting"].includes(twitchState) ? "Disconnect" : "Connect Twitch";
	} catch {
		/* keep the last status */
	}
}
$("twitch-btn").addEventListener("click", () =>
	run(async () => {
		if (["connected", "connecting"].includes(twitchState)) {
			await invoke("twitch_disconnect");
		} else {
			const code = await invoke("twitch_connect");
			toast(`Go to twitch.tv/activate and enter ${code.userCode}. Chat commands: !sr, !video, !shoutout.`);
		}
		await refreshTwitch();
	}),
);

$("t-replies").addEventListener("change", (e) =>
	run(async () => {
		settings = await invoke("set_twitch_replies", { on: e.target.checked });
		if (settings.twitch.replies) toast("Replies on. Disconnect and connect Twitch again once to allow chat messages.");
	}),
);

$("overlay-btn").addEventListener("click", () =>
	run(async () => {
		await navigator.clipboard.writeText(await invoke("overlay_url"));
		toast("Overlay URL copied. In OBS add a Browser Source and paste it. Keep it private: it includes the overlay key.");
	}),
);

// ---- TikTok via TikFinity ----
async function refreshTikTok() {
	try {
		const t = await invoke("tikfinity_status");
		const labels = { off: "off", connecting: "waiting for TikFinity", connected: "connected", error: "TikFinity not running" };
		$("tiktok-state").textContent = `TikTok (TikFinity): ${labels[t.state] || "off"}${typeof t.viewers === "number" ? ` · ${t.viewers} watching` : ""}`;
		$("tiktok-info").textContent = (t.state === "error" ? t.error : t.lastEvent) || "";
	} catch {
		/* keep the last status */
	}
}
$("t-tiktok").addEventListener("change", (e) =>
	run(async () => {
		settings = await invoke("set_tikfinity", { enabled: e.target.checked });
		if (settings.tikfinity.enabled) toast("Open TikFinity and go live. Chat commands: !sr, !video, !shoutout.");
		await refreshTikTok();
	}),
);

// ---- actions ----
async function refresh() {
	try {
		render(await invoke("queue_state"));
	} catch (e) {
		$("conn").textContent = "Connection problem: retrying";
		if (/credential|Connect/.test(String(e))) showConnect();
	}
}
function act(action, id) {
	run(async () => {
		await invoke("moderate", { action, id });
		await refresh();
	});
}
function setKinds() {
	run(async () => {
		await invoke("set_kinds", { songs: $("t-songs").checked, videos: $("t-videos").checked, shoutouts: $("t-shoutouts").checked });
		await refresh();
	});
}
for (const id of ["t-songs", "t-videos", "t-shoutouts"]) $(id).addEventListener("change", setKinds);
$("pause").addEventListener("click", () =>
	run(async () => {
		await invoke("set_live", { on: !(last && last.intake) });
		await refresh();
	}),
);
$("end").addEventListener("click", () => {
	if (!confirm("End this session? Viewers can no longer send requests with this code.")) return;
	run(async () => {
		await invoke("end_session");
		localStorage.removeItem(liveSinceKey());
		settings = await invoke("get_settings");
		showConnect();
	});
});

function startPolling() {
	clearInterval(pollTimer);
	refresh();
	refreshPlayer();
	refreshTwitch();
	refreshTikTok();
	pollTimer = setInterval(() => {
		if (document.visibilityState !== "visible") return;
		refresh();
		refreshPlayer();
		refreshTwitch();
		refreshTikTok();
	}, 3000);
}
function showConsole() {
	$("connect").hidden = true;
	$("console").hidden = false;
	if (!localStorage.getItem(liveSinceKey())) localStorage.setItem(liveSinceKey(), String(Date.now()));
	showProfile();
	startPolling();
}
function showConnect() {
	clearInterval(pollTimer);
	$("console").hidden = true;
	$("connect").hidden = false;
	$("session-pill").hidden = true;
	$("conn").textContent = "Not connected";
}

$("create").addEventListener("click", () =>
	run(async () => {
		await invoke("create_session", { minutes: Number($("minutes").value) });
		settings = await invoke("get_settings");
		toast(`Session ${settings.sessionCode} created. Turn on song requests when you're ready.`);
		showConsole();
	}),
);
$("connect-btn").addEventListener("click", () =>
	run(async () => {
		await invoke("connect_session", { code: $("code").value, credential: $("credential").value });
		$("credential").value = "";
		settings = await invoke("get_settings");
		showConsole();
	}),
);

setInterval(tickClock, 1000);
(async () => {
	try {
		settings = await invoke("get_settings");
	} catch (e) {
		toast(e);
		return;
	}
	if (settings.sessionCode) showConsole();
	else showConnect();
})();
