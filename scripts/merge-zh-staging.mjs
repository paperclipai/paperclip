#!/usr/bin/env node
// Merge per-page Simplified-Chinese staging key maps into the canonical
// `en.json` + `zh-CN.json` locale files.
//
// Each staging file (produced by the localize-pages-zh workflow) is a flat map
// of dotted keys to translations:
//   { "pages.dashboard.title": { "en": "Dashboard", "zh": "仪表盘" }, ... }
//
// This script deep-merges every key into `en.json` (en value) and
// `zh-CN.json` (zh value), preserving everything already there. It validates
// interpolation placeholder parity and reports collisions, but never throws on
// a single bad file — it skips and reports so one stray file can't block the
// whole merge.
//
// Usage: node scripts/merge-zh-staging.mjs [stagingDir]
// After this, run: node scripts/sync-ui-locales.mjs   (to back-fill other locales)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const stagingDir = process.argv[2] || join(repoRoot, ".i18n-zh-staging");
const localesDir = join(repoRoot, "ui", "src", "i18n", "locales");
const enPath = join(localesDir, "en.json");
const zhPath = join(localesDir, "zh-CN.json");

const placeholders = (value) =>
  Array.from(String(value).matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g), (m) => m[1]).sort().join(",");

function setDeep(root, dottedKey, value, warnings) {
  const parts = dottedKey.split(".");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (node[part] === undefined) {
      node[part] = {};
    } else if (typeof node[part] === "string") {
      warnings.push(`collision: "${dottedKey}" — "${parts.slice(0, i + 1).join(".")}" already a string leaf; skipped`);
      return false;
    }
    node = node[part];
  }
  const leaf = parts[parts.length - 1];
  if (typeof node[leaf] === "object" && node[leaf] !== null) {
    warnings.push(`collision: "${dottedKey}" already an object; skipped`);
    return false;
  }
  node[leaf] = value;
  return true;
}

if (!existsSync(stagingDir)) {
  console.error(`Staging directory not found: ${stagingDir}`);
  process.exit(1);
}

const en = JSON.parse(readFileSync(enPath, "utf8"));
const zh = JSON.parse(readFileSync(zhPath, "utf8"));

const stagingFiles = readdirSync(stagingDir).filter((f) => f.endsWith(".json")).sort();
const warnings = [];
let addedEn = 0;
let addedZh = 0;
let badFiles = 0;
let processedKeys = 0;
const seen = new Map(); // dottedKey -> en (to detect cross-file duplicate keys)

for (const file of stagingFiles) {
  const path = join(stagingDir, file);
  let map;
  try {
    map = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    badFiles++;
    warnings.push(`bad JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    badFiles++;
    warnings.push(`${file}: not a flat object`);
    continue;
  }
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object" || typeof entry.en !== "string" || typeof entry.zh !== "string") {
      warnings.push(`${file}: "${key}" missing string en/zh; skipped`);
      continue;
    }
    if (placeholders(entry.en) !== placeholders(entry.zh)) {
      warnings.push(`${file}: "${key}" placeholder mismatch en={{${placeholders(entry.en)}}} zh={{${placeholders(entry.zh)}}}; skipped`);
      continue;
    }
    if (seen.has(key) && seen.get(key) !== entry.en) {
      warnings.push(`duplicate key across files: "${key}" (en differs); keeping first`);
      continue;
    }
    seen.set(key, entry.en);
    processedKeys++;
    if (setDeep(en, key, entry.en, warnings)) addedEn++;
    if (setDeep(zh, key, entry.zh, warnings)) addedZh++;
  }
}

writeFileSync(enPath, `${JSON.stringify(en, null, 2)}\n`);
writeFileSync(zhPath, `${JSON.stringify(zh, null, 2)}\n`);

console.log(`Staging files: ${stagingFiles.length} (bad: ${badFiles})`);
console.log(`Keys processed: ${processedKeys} | en set: ${addedEn} | zh set: ${addedZh}`);
if (warnings.length > 0) {
  console.log(`\nWarnings (${warnings.length}):`);
  for (const w of warnings.slice(0, 60)) console.log(`  - ${w}`);
  if (warnings.length > 60) console.log(`  …and ${warnings.length - 60} more`);
}
console.log(`\nUpdated:\n  ${enPath}\n  ${zhPath}\nNext: node scripts/sync-ui-locales.mjs`);
