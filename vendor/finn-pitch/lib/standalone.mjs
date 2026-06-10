// Package dist/finn-investor.html into a single self-contained file that opens
// by double-click (no server): inlines hero images (base64), snap iframes
// (srcdoc), and reveal.js + reveal.css. Google Fonts stays via CDN (needs net).
//   node lib/standalone.mjs  ->  dist/finn-investor-standalone.html
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
let html = readFileSync(join(root, "dist", "finn-investor.html"), "utf8");

const attrEsc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const fetchText = (url) => execSync(`curl -fsSL "${url}"`, { encoding: "utf8", maxBuffer: 1 << 26 });

// 1 · snap iframes  src="/snaps/x.html" -> srcdoc="<inlined>"
let snaps = 0;
html = html.replace(/src="\/snaps\/([\w-]+\.html)"/g, (m, file) => {
  const p = join(root, "assets", "snaps", file);
  if (!existsSync(p)) return m;
  snaps++;
  return `srcdoc="${attrEsc(readFileSync(p, "utf8"))}"`;
});

// 2 · hero bg images  url('/asset/industry-hero/x.jpg') -> data URI
let heroes = 0;
html = html.replace(/url\('\/asset\/industry-hero\/([\w-]+\.(?:jpg|jpeg|png))'\)/g, (m, file) => {
  const p = join(root, "assets", "industry-hero", file);
  if (!existsSync(p)) return m;
  heroes++;
  const ext = file.split(".").pop().replace("jpg", "jpeg");
  return `url('data:image/${ext};base64,${readFileSync(p).toString("base64")}')`;
});

// 3 · inline reveal css + js (fonts stay on CDN)
const revealCss = fetchText("https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css");
const revealJs = fetchText("https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js");
html = html.replace(/<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/reveal\.js@5\/dist\/reveal\.css">/, `<style>\n${revealCss}\n</style>`);
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/reveal\.js@5\/dist\/reveal\.js"><\/script>/, `<script>\n${revealJs}\n</script>`);

const out = join(root, "dist", "finn-investor-standalone.html");
writeFileSync(out, html);
const mb = (Buffer.byteLength(html) / 1e6).toFixed(2);
console.log(`✅  Standalone: ${out}  (${mb} MB · ${snaps} snaps + ${heroes} heroes inlined, reveal inlined)`);
