import { readFile, writeFile } from "node:fs/promises";

// Public names and toolkit identifiers only. Search never sends user queries
// to this website or requires a Composio account.
const source = "https://docs.composio.dev/toolkits";
const response = process.argv[2] ? null : await fetch(source);
if (response && !response.ok) throw new Error(`Catalog returned ${response.status}`);
const html = process.argv[2] ? await readFile(process.argv[2], "utf8") : await response.text();
const decode = (value) => value.replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|quot|apos|lt|gt);/gi,
  (_, hex, decimal, named) => hex || decimal ? String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10))
    : ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[named.toLowerCase()]);
const entries = new Map();
for (const match of html.matchAll(/<a\b[^>]*href="\/toolkits\/([a-z0-9_]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
  const name = match[2].match(/<span\b[^>]*class="truncate text-sm font-medium[^"\n]*"[^>]*>([^<]+)<\/span>/)?.[1];
  if (name) entries.set(match[1], decode(name));
}
if (entries.size < 1000) throw new Error(`Catalog extraction returned only ${entries.size} entries; inspect the source before updating`);
const rows = [...entries].sort(([a], [b]) => a.localeCompare(b));
const result = `{
  "source": ${JSON.stringify(source)},
  "verifiedAt": ${JSON.stringify(new Date().toISOString().slice(0, 10))},
  "toolkits": [
${rows.map(row => `    ${JSON.stringify(row)}`).join(",\n")}
  ]
}
`;
await writeFile(new URL("../packages/shared/src/composio-search-catalog.json", import.meta.url), result);
console.log(`Saved ${rows.length} public toolkit names from ${source}`);
