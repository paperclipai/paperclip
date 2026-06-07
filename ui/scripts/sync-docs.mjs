// Sync Mintlify docs/ -> ui/public/docs-content/ (markdown copies + manifest with titles)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), ".."); // repo root from ui/
const SRC = path.join(ROOT, "docs");
const OUT = path.resolve(process.cwd(), "public/docs-content");

function frontmatterTitle(md, fallback) {
  const m = md.match(/^---\s*([\s\S]*?)\s*---/);
  if (m) {
    const t = m[1].match(/title:\s*(.+)/);
    if (t) return t[1].trim().replace(/^["']|["']$/g, "");
  }
  return fallback;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Copy static asset dirs (images, etc.) so in-app docs render embedded media.
for (const dir of ["images", "assets", "logo"]) {
  const src = path.join(SRC, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(OUT, dir), { recursive: true });
}

const cfg = JSON.parse(fs.readFileSync(path.join(SRC, "docs.json"), "utf8"));
const tabs = [];
let copied = 0;

for (const tab of cfg.navigation.tabs) {
  const groups = [];
  for (const g of tab.groups) {
    const pages = [];
    for (const pg of g.pages) {
      // find the source file (.md or .mdx)
      let file = null;
      for (const ext of [".md", ".mdx"]) {
        const p = path.join(SRC, pg + ext);
        if (fs.existsSync(p)) { file = p; break; }
      }
      if (!file) { console.warn("MISSING", pg); continue; }
      const md = fs.readFileSync(file, "utf8");
      const title = frontmatterTitle(md, pg.split("/").pop());
      const dest = path.join(OUT, pg + ".md");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, md);
      copied++;
      pages.push({ path: pg, title });
    }
    if (pages.length) groups.push({ group: g.group, pages });
  }
  if (groups.length) tabs.push({ tab: tab.tab, groups });
}

const manifest = { name: cfg.name, description: cfg.description, tabs };
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`synced ${copied} pages, ${tabs.length} tabs -> public/docs-content/`);
