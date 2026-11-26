import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ORIGIN = "https://yts.foulfoxhacks.dev";
const SITEMAP_PATH = path.join(ROOT, "public", "sitemap.xml");
const SITEMAP_PAGE = path.join(ROOT, "sitemap.html");
const CSS_PATH = path.join(ROOT, "public", "sitemap.css");
const HEADERS_PATH = path.join(ROOT, "public", "_headers");
const failures = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "apps", "test", ".cloudflare", "dist"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}
function pagePath(file) {
  let rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (rel.startsWith("public/")) rel = rel.slice("public/".length);
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return "/" + rel.slice(0, -"/index.html".length);
  return "/" + rel.replace(/\.html$/, "");
}
function attr(tag, name) {
  const match = tag.match(new RegExp("\\b" + name + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return match?.[2] ?? "";
}
function hasNoindexMeta(html) {
  const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => m[0]);
  const tag = tags.find(t => /\bname\s*=\s*["']robots["']/i.test(t));
  return attr(tag ?? "", "content").toLowerCase().includes("noindex");
}
function headerNoindex(urlPath, headersText) {
  let activePattern = "";
  for (const line of headersText.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      activePattern = line.trim();
      continue;
    }
    if (!/x-robots-tag\s*:\s*noindex/i.test(line)) continue;
    const escaped = activePattern.split("*").map(part => part.replaceAll(".", "\\.")).join(".*");
    if (new RegExp("^" + escaped + "$").test(urlPath)) return true;
  }
  return false;
}

const xml = fs.readFileSync(SITEMAP_PATH, "utf8");
const human = fs.readFileSync(SITEMAP_PAGE, "utf8");
const css = fs.readFileSync(CSS_PATH, "utf8");
const headers = fs.readFileSync(HEADERS_PATH, "utf8");
if (!xml.startsWith('<?xml version="1.0"')) failures.push("sitemap.xml must begin with an XML declaration.");
if (!xml.includes('<?xml-stylesheet type="text/css" href="/sitemap.css"?>')) failures.push("sitemap.xml must link its CSS stylesheet with an xml-stylesheet CSS processing instruction.");
if (!xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')) failures.push("sitemap.xml is missing the Sitemap protocol namespace.");
if (!css.includes("sm|urlset") || !css.includes("sm|url")) failures.push("sitemap.css must style the namespaced sitemap root and URL entries.");
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
if (!locs.length) failures.push("sitemap.xml contains no <loc> entries.");
for (const loc of locs) if (!loc.startsWith(ORIGIN + "/") || /\.html$/.test(loc)) failures.push("sitemap.xml entry is off-site or a redirecting .html URL: " + loc);
if (new Set(locs).size !== locs.length) failures.push("sitemap.xml contains duplicate <loc> entries.");
const listed = new Set(locs);

for (const file of walk(ROOT)) {
  const html = fs.readFileSync(file, "utf8");
  const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).find(t => /\brel\s*=\s*["']canonical["']/i.test(t)) ?? "";
  const canonical = attr(canonicalTag, "href");
  const route = canonical ? new URL(canonical).pathname : pagePath(file);
  const isNoindex = hasNoindexMeta(html) || headerNoindex(route, headers);
  const expected = canonical || ORIGIN + route;
  if (isNoindex) {
    if (listed.has(expected)) failures.push("Noindex page appears in sitemap.xml: " + file + " → " + expected);
    continue;
  }
  if (!canonical) {
    failures.push("Indexable static HTML page is missing a canonical URL: " + file);
    continue;
  }
  // Workers assets (auto-trailing-slash) 307 /page.html → /page and /dir → /dir/, so a canonical or
  // sitemap entry that isn't the served route points crawlers at a redirect.
  if (new URL(canonical).pathname !== pagePath(file)) failures.push("Canonical is not the served route (it redirects): " + file + " → " + canonical + " (served at " + pagePath(file) + ")");
  if (!listed.has(canonical)) failures.push("Indexable page is missing from sitemap.xml: " + file + " → " + canonical);
}

const requiredHumanEntries = [
  'href="/stream"', 'href="/stream/overlay"', 'PREVIEW · NOINDEX',
  'href="/ecosystem"', 'href="/privacy"', 'href="/terms"',
  '/api/stream/v1/*', '/api/rooms/*', '/api/inworld/*', '/api/auth/*',
  '/vrc/*', '/auth/*', '/tt/start', '/?view=library', '/?view=link', '/?room=',
  '/plugin-sandbox', '/api/openapi.json'
];
for (const token of requiredHumanEntries) {
  if (!human.includes(token)) failures.push("Human sitemap is missing documented route or classification: " + token);
}

if (failures.length) {
  console.error("Sitemap validation failed:\n" + failures.map(x => " - " + x).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Sitemap validation passed: " + locs.length + " canonical URLs; static indexable/noindex pages and documented route families checked.");
}
