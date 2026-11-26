"""Check every locked dependency against OSV.dev (aggregates GitHub advisories, RustSec and npm;
links NVD CVEs). Exits 1 on any advisory not listed in ACCEPTED. No dependencies.
Usage: python -I tools/osv-check.py"""
import json, os, re, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARGO = ["apps/stream-desktop/Cargo.lock"]
NPM = ["package-lock.json", "apps/pearconnect/package-lock.json", "apps/pearconnect/relay/package-lock.json", "apps/pearconnect/website/package-lock.json", "workers/youtube-chat/package-lock.json"]

# Reviewed advisories (id -> reason). Re-review whenever a lockfile changes.
ACCEPTED = {
    "RUSTSEC-2024-0429": "glib 0.18 VariantStrIter unsound; CVSS4 integrity Low, no CVE; Linux-only via Tauri GTK3; not used by our code; fix needs GTK4",
    "GHSA-wrw7-89jp-8q8g": "alias of RUSTSEC-2024-0429",
    "RUSTSEC-2026-0543": "chrono unmaintained (notice, not a vulnerability); transitive via Tauri",
    "RUSTSEC-2024-0370": "proc-macro-error unmaintained (build-time macro); transitive via Tauri",
    "RUSTSEC-2026-0370": "zvariant unmaintained (notice); transitive",
    "RUSTSEC-2026-0371": "zbus_names unmaintained (notice); transitive",
    "RUSTSEC-2026-0372": "zvariant_derive unmaintained (notice); transitive",
}

found = {}  # (ecosystem, name, version) -> set of lockfiles
for rel in CARGO:
    text = open(os.path.join(ROOT, rel), encoding="utf-8").read().replace("\r\n", "\n")
    for name, ver in re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"', text):
        found.setdefault(("crates.io", name, ver), set()).add(rel)
for rel in NPM:
    data = json.load(open(os.path.join(ROOT, rel), encoding="utf-8"))
    for key, info in (data.get("packages") or {}).items():
        if key and "version" in info and not info.get("link"):
            found.setdefault(("npm", info.get("name") or key.split("node_modules/")[-1], info["version"]), set()).add(rel)

keys = sorted(found)
hits = {}
for i in range(0, len(keys), 500):
    batch = keys[i:i + 500]
    body = json.dumps({"queries": [{"package": {"name": n, "ecosystem": e}, "version": v} for e, n, v in batch]}).encode()
    req = urllib.request.Request("https://api.osv.dev/v1/querybatch", data=body, headers={"Content-Type": "application/json"})
    for k, r in zip(batch, json.load(urllib.request.urlopen(req, timeout=60))["results"]):
        if r.get("vulns"):
            hits[k] = [x["id"] for x in r["vulns"]]

print(f"checked {len(keys)} package versions ({sum(k[0] == 'crates.io' for k in keys)} crates, {sum(k[0] == 'npm' for k in keys)} npm)")
new = []
for k, ids in sorted(hits.items()):
    fresh = [x for x in ids if x not in ACCEPTED]
    new += fresh
    print(f"[{'NEW' if fresh else 'accepted'}] {k[0]} {k[1]} {k[2]}: {', '.join(ids)}  [{'; '.join(sorted(found[k]))}]")
if new:
    sys.exit(f"FAIL: {len(new)} unreviewed advisories. Upgrade, replace, or review and add to ACCEPTED with a reason.")
print("OK: no unreviewed advisories")
