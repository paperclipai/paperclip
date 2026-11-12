#!/usr/bin/env node
// Refresh only Arcade's public support claim; never update Composio verification dates.
import { readFile, writeFile } from "node:fs/promises";
const source = "https://docs.arcade.dev/en/resources/integrations";
const args = process.argv.slice(2);
const verifiedAt = args[args.indexOf("--verified-at") + 1];
if (!args.includes("--verified-at") || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) {
  throw new Error("Supply --verified-at YYYY-MM-DD after reviewing the official public Arcade catalog.");
}
const input = args.includes("--input") ? args[args.indexOf("--input") + 1] : null;
let html;
if (input) html = await readFile(input, "utf8");
else {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Arcade catalog request failed (${response.status})`);
  html = await response.text();
}
const records = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*?")\]\)/g)]
  .map((match) => JSON.parse(match[1])).join("");
const start = records.indexOf('"toolkits":[');
if (start < 0) throw new Error("Arcade catalog payload was not found; preserve the previous snapshot.");
const rest = records.slice(start + '"toolkits":'.length);
let end = 0, depth = 0, quoted = false, escaped = false;
for (; end < rest.length; end++) {
  const char = rest[end];
  if (escaped) { escaped = false; continue; }
  if (quoted && char === "\\") { escaped = true; continue; }
  if (char === '"') { quoted = !quoted; continue; }
  if (!quoted && char === "[") depth++;
  if (!quoted && char === "]" && --depth === 0) { end++; break; }
}
const toolkits = JSON.parse(rest.slice(0, end));
const apps = toolkits.filter((app) => app.isComingSoon === false && app.isHidden === false).map((app) => {
  const toolkit = app.relativeDocsLink.split("/").at(-1);
  const slug = toolkit.replaceAll("_", "-");
  const logoUrl = new URL(app.publicIconUrl, source);
  const docsUrl = new URL(app.hasPage ? app.docsLink : source);
  if (!/^[a-z0-9-]+$/.test(slug) || !app.label || typeof app.id !== "string"
    || logoUrl.protocol !== "https:" || !["docs.arcade.dev", "design-system.arcade.dev"].includes(logoUrl.hostname)
    || docsUrl.origin !== "https://docs.arcade.dev") throw new Error(`Invalid public Arcade entry: ${app.id}`);
  return { slug, toolkit, name: app.label, logoUrl: logoUrl.href, docsUrl: docsUrl.href, aliases: [app.id, toolkit], category: app.category };
}).sort((a, b) => a.slug.localeCompare(b.slug, "en"));
if (apps.length < 100 || new Set(apps.map((app) => app.slug)).size !== apps.length) {
  throw new Error("Arcade catalog is incomplete or contains duplicate slugs; preserve the previous snapshot.");
}
const target = new URL("../packages/shared/src/arcade-app-catalog.json", import.meta.url);
await writeFile(target, `${JSON.stringify({ source, verifiedAt, apps }, null, 2)}\n`);
console.log(`Indexed ${apps.length} public Arcade apps (${verifiedAt}).`);
