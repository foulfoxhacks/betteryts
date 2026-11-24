import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ORIGIN = "https://yts.foulfoxhacks.dev";
const SITEMAP_PATH = path.join(ROOT, "public", "sitemap.xml");
const SITEMAP_PAGE = path.join(ROOT, "sitemap.html");
const CSS_PATH = path.join(ROOT, "public", "sitemap.css");
const failures = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "apps" || entry.name === "test") continue;
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
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"/index.html".length)}`;
  return `/${rel.replace(/\\.html$/, "")}`;
}
function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? "";
}
const xml = fs.readFileSync(SITEMAP_PATH, "utf8");
const human = fs.readFileSync(SITEMAP_PAGE, "utf8");
const css = fs.readFileSync(CSS_PATH, "utf8");
if (!xml.startsWith('<?xml version="1.0"')) failures.push("sitemap.xml must begin with an XML declaration.");
if (!xml.includes('<?xml-stylesheet type="text/css" href="/sitemap.css"?>')) failures.push("sitemap.xml must link the CSS stylesheet using an xml-stylesheet CSS processing instruction.");
if (!/xmlns="http:\/\/www\\.sitemaps\\.org\/schemas\/sitemap\/0\\.9"/.test(xml)) failures.push("sitemap.xml is missing the Sitemap protocol namespace.");
if (!css.includes("sm|urlset") || !css.includes("sm|url")) failures.push("sitemap.css must style the namespaced sitemap root and URL entries.");
const locs = [...xml.matchAll(/<loc>([^<]+)<\\/loc>/g)].map(m => m[1].trim());
if (!locs.length) failures.push("sitemap.xml contains no <loc> entries.");
if (new Set(locs).size !== locs.length) failures.push("sitemap.xml contains duplicate <loc> entries.");
const listed = new Set(locs);

for (const file of walk(ROOT)) {
  const html = fs.readFileSync(file, "utf8");
  const robotsTag = html.match(/<meta\\b[^>]*name=["']robots["'][^>]*>/i)?.[0] ?? "";
  const robots = attr(robotsTag, "content").toLowerCase();
  const isNoindex = robots.includes("noindex");
  const canonicalTag = html.match(/<link\\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] ?? "";
  const canonical = attr(canonicalTag, "href");
  const expected = canonical || ORIGIN + pagePath(file);
  if (isNoindex) {
    if (listed.has(expected)) failures.push(`Noindex page appears in sitemap.xml: ${file} → ${expected}`);
    continue;
  }
  if (!canonical) {
    failures.push(`Indexable static HTML page is missing a canonical URL: ${file}`);
    continue;
  }
  if (!listed.has(canonical)) failures.push(`Indexable page is missing from sitemap.xml: ${file} → ${canonical}`);
}

const requiredHumanEntries = [
  'href="/stream"', 'href="/stream/overlay"', 'PREVIEW · NOINDEX',
  '/api/stream/v1/*', '/api/rooms/*', '/api/inworld/*', '/api/auth/*',
  '/vrc/*', '/auth/*', '/tt/start', '/?view=library', '/?view=link', '/?room=',
  '/plugin-sandbox', '/api/openapi.json'
];
for (const token of requiredHumanEntries) if (!human.includes(token)) failures.push(`Human sitemap is missing documented route or classification: ${token}`);

if (failures.length) {
  console.error("Sitemap validation failed:\n" + failures.map(x => ` - ${x}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Sitemap validation passed: ${locs.length} canonical URLs; static indexable/noindex pages and documented route families checked.`);
}
