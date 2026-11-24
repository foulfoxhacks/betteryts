// BetterYTS Stream overlay: polls the read-only overlay state. URL: /stream/overlay#CODE.TOKEN
// The token lives in the fragment, so it never reaches server logs or a Referer header.
const [code, token] = location.hash.slice(1).split(".");
const $ = (id) => document.getElementById(id);
const valid = /^[A-HJ-NP-Z2-9]{8}$/.test(code ?? "") && /^[a-f0-9]{64}$/.test(token ?? "");
let revision = -1;

function render(s) {
	$("overlay").hidden = false;
	const now = s.nowPlaying;
	$("title").textContent = now ? now.title : "Nothing playing";
	$("by").textContent = now ? `${now.creator}${now.requester ? ` · requested by ${now.requester}` : ""}` : "";
	$("art").hidden = !now?.thumbnail;
	if (now?.thumbnail?.startsWith("https://i.ytimg.com/")) $("art").src = now.thumbnail;
	$("next-label").hidden = !s.upcoming.length;
	$("next").replaceChildren(
		...s.upcoming.slice(0, 5).map((u) => {
			const li = document.createElement("li");
			li.textContent = `${u.title} — ${u.requester}`;
			return li;
		}),
	);
	$("hint").textContent = s.accepting ? `Request with ${s.command} <song>` : "Requests are paused";
}

async function poll() {
	try {
		const res = await fetch(`/api/stream/v1/sessions/${code}/overlay?token=${token}`, { cache: "no-store" });
		const data = await res.json();
		if (data.ok && data.revision !== revision) {
			revision = data.revision;
			render(data);
		}
		if (res.status === 401 || res.status === 404) return; // revoked or ended: stop polling
	} catch {
		/* keep the last state on screen */
	}
	setTimeout(poll, 3000);
}

if (valid) poll();
