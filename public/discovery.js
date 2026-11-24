(() => {
  const source = document.body.dataset.source;
  const output = document.querySelector("[data-document]");
  const status = document.querySelector("[data-status]");
  const copy = document.querySelector("[data-copy]");
  if (!source || !output) return;
  let original = "";
  fetch(source, { headers: { Accept: "text/plain" } })
    .then(response => { if (!response.ok) throw new Error("HTTP " + response.status); return response.text(); })
    .then(text => { original = text; output.textContent = text; status.textContent = "Loaded from " + source; })
    .catch(() => { output.textContent = "The source file could not be loaded. Use the original-file link above to open it directly."; status.textContent = "Unable to load source"; });
  copy?.addEventListener("click", async () => {
    try {
      if (!original) throw new Error("Source has not loaded");
      await navigator.clipboard.writeText(original);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy text"; }, 1600);
    } catch { status.textContent = "Copy unavailable — select the text and copy it manually."; }
  });
})();
