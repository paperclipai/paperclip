#!/usr/bin/env node
/**
 * build-index.js — generic, dependency-free indexer for a dynamic-lookup skill.
 *
 * Reads `lookup.config.json` (sibling of this script's parent, i.e. the skill
 * dir) and walks the configured data folder, producing the Tier-2 router that
 * lets a model find the one file it needs without reading the whole corpus:
 *
 *   index.json         — { entries[], aliasIndex }   (always)
 *   detail-index.json  — { detailIndex: key -> file } (only if detail keys exist)
 *
 * The index is ALWAYS derived from the data, so it cannot drift. Re-run after
 * any change to the corpus:
 *
 *   node scripts/build-index.js
 *
 * Config (lookup.config.json):
 * {
 *   "name":     "docs-lookup",
 *   "dataDir":  "/abs/path/to/corpus",   // absolute = survives symlinks
 *   "include":  ["**\/*.md"],            // globs relative to dataDir
 *   "exclude":  ["**\/node_modules/**"], // optional
 *   "parser":   "markdown",              // "markdown" | "json" | "auto"
 *   "json": {                            // used when a file is parsed as json
 *     "categoryField": "category",
 *     "aliasFields":   ["category", "name"],
 *     "itemsField":    "apis",           // optional: array of sub-items
 *     "itemNameField": "name"            // each item's fine-grained key
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(SKILL_DIR, 'lookup.config.json');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(CONFIG_PATH)) die(`Missing config: ${CONFIG_PATH}`);
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DATA_DIR = path.resolve(SKILL_DIR, cfg.dataDir);
if (!fs.existsSync(DATA_DIR)) die(`dataDir not found: ${DATA_DIR}`);

const include = cfg.include && cfg.include.length ? cfg.include : ['**/*'];
const exclude = cfg.exclude || [];
const parserMode = cfg.parser || 'auto';
const jsonCfg = cfg.json || {};

/** Minimal glob -> RegExp: supports **, *, ? and literal segments. */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // consume the slash after **
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
const incRe = include.map(globToRe);
const excRe = exclude.map(globToRe);
const matches = (rel) => incRe.some((r) => r.test(rel)) && !excRe.some((r) => r.test(rel));

/** Collect file paths (relative to DATA_DIR) that match include/exclude. */
function walk(dir, base = DATA_DIR, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      if (!excRe.some((r) => r.test(rel + '/') || r.test(rel))) walk(full, base, out);
    } else if (matches(rel)) out.push(rel);
  }
  return out;
}

/** camelCase / kebab / snake / path -> lowercase space-separated tokens. */
function normalize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_/.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    v = v.trim();
    if (/^\[.*\]$/.test(v)) {
      fm[k] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else fm[k] = v.replace(/^["']|["']$/g, '');
  }
  return fm;
}

function parseMarkdown(rel, text) {
  const fm = parseFrontmatter(text);
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim());
  const stem = path.basename(rel).replace(/\.[^.]+$/, '');
  const title = fm.title || headings[0] || stem;
  const firstPara = (body.replace(/^#{1,6}\s+.+$/gm, '').match(/\S[^\n]*(?:\n[^\n#]+)*/) || [''])[0];
  const summary = (fm.description || firstPara || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  // Keep the main-index aliases LIGHT (stem, title, frontmatter tags) so
  // index.json stays cheap to read. Section headings are the heavy set — they
  // go ONLY into detail-index.json, which is read on demand.
  const aliasSet = new Set([normalize(stem), normalize(title)]);
  for (const t of [].concat(fm.tags || [], fm.aliases || [])) aliasSet.add(normalize(t));

  return {
    entry: { file: rel, title, summary, aliases: [...aliasSet].filter(Boolean), sectionCount: headings.length },
    aliases: aliasSet,
    detailKeys: headings.map(normalize), // section heading -> file (detail-index only)
  };
}

function parseJson(rel, text) {
  const data = JSON.parse(text);
  const category = data[jsonCfg.categoryField || 'category'] || path.basename(rel).replace(/\.[^.]+$/, '');
  const aliasFields = jsonCfg.aliasFields || ['category', 'name'];
  const aliasSet = new Set([normalize(category), normalize(path.basename(rel).replace(/\.[^.]+$/, ''))]);
  for (const f of aliasFields) if (data[f]) aliasSet.add(normalize(data[f]));

  let items = [];
  let operations = [];
  if (jsonCfg.itemsField && Array.isArray(data[jsonCfg.itemsField])) {
    items = data[jsonCfg.itemsField].map((it) => it[jsonCfg.itemNameField || 'name']).filter(Boolean);
    operations = [...new Set(items.map((n) => String(n).split('-')[0]))].sort();
  }
  return {
    entry: { file: rel, category, aliases: [...aliasSet].filter(Boolean), operations, itemCount: items.length },
    aliases: aliasSet,
    detailKeys: items, // exact item name -> file
    detailRaw: true,
  };
}

const files = walk(DATA_DIR).sort();
const entries = [];
const aliasIndex = {};
const detailIndex = {};
let skipped = 0;

for (const rel of files) {
  const ext = path.extname(rel).toLowerCase();
  const useJson = parserMode === 'json' || (parserMode === 'auto' && ext === '.json');
  let parsed;
  try {
    const text = fs.readFileSync(path.join(DATA_DIR, rel), 'utf8');
    parsed = useJson ? parseJson(rel, text) : parseMarkdown(rel, text);
  } catch {
    skipped++;
    continue;
  }
  entries.push(parsed.entry);
  for (const a of parsed.aliases) if (a && !(a in aliasIndex)) aliasIndex[a] = rel;
  for (const k of parsed.detailKeys) {
    const key = parsed.detailRaw ? k : k; // detail keys already normalized for md
    if (key) detailIndex[key] = rel;
  }
}

const header = `Auto-generated by scripts/build-index.js — do not edit by hand.`;
fs.writeFileSync(
  path.join(SKILL_DIR, 'index.json'),
  JSON.stringify({ _generated: header, name: cfg.name, dataDir: DATA_DIR, fileCount: entries.length, entries, aliasIndex }, null, 2),
);

const detailCount = Object.keys(detailIndex).length;
if (detailCount) {
  fs.writeFileSync(
    path.join(SKILL_DIR, 'detail-index.json'),
    JSON.stringify({ _generated: header, name: cfg.name, dataDir: DATA_DIR, detailIndex }, null, 2),
  );
}

console.log(
  `Indexed ${entries.length} files, ${Object.keys(aliasIndex).length} aliases` +
    (detailCount ? `, ${detailCount} detail keys` : '') +
    ` (skipped ${skipped}).`,
);
