// BetterYTS Stream page: the website request form (POST /api/stream/v1/sessions/{code}/requests).
const form = document.getElementById("stream-request");
const status = document.getElementById("stream-status");

// A shared link can carry the code: /stream#ABCD2345
const fromHash = location.hash.slice(1).toUpperCase();
if (/^[A-HJ-NP-Z2-9]{8}$/.test(fromHash)) form.elements.code.value = fromHash;

let pending = null; // { code, id, fingerprint } so a retry of the same request is idempotent

form?.addEventListener("submit", async (e) => {
	e.preventDefault();
	const code = form.elements.code.value.trim().toUpperCase();
	const name = form.elements.name.value.trim();
	const query = form.elements.query.value.trim();
	const kind = form.elements.kind.value;
	const fingerprint = JSON.stringify([code, name, kind, query]);
	if (!pending || pending.fingerprint !== fingerprint) pending = { code, id: crypto.randomUUID(), fingerprint };
	const button = form.querySelector("button");
	button.disabled = true;
	status.textContent = "Sending…";
	try {
		const res = await fetch(`/api/stream/v1/sessions/${encodeURIComponent(code)}/requests`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: pending.id, name, query, kind }),
		});
		const data = await res.json();
		status.textContent = data.message || (data.ok ? "Request received." : "That didn't work. Try again.");
		if (data.state) pending = null; // a final answer: the next submit is a new request
		if (data.state === "queued" && typeof data.ahead === "number") status.textContent += ` ${data.ahead} ahead of you.`;
	} catch {
		status.textContent = "Couldn't reach BetterYTS. Send again to retry the same request safely.";
	} finally {
		button.disabled = false;
	}
});
