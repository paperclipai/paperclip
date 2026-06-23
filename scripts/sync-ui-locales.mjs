#!/usr/bin/env node
// Sync every UI locale file against the English source of truth.
//
// `ui/src/i18n/locales.ts` validates that each locale mirrors `en.json`'s key
// structure *exactly* (missing or extra keys throw at startup). When new keys
// are added to `en.json`, this script back-fills every other locale so the app
// keeps booting: existing translations are preserved, missing keys inherit the
// English value (graceful fallback, surfaced for translation later), and keys
// no longer present in English are dropped.
//
// Usage:
//   node scripts/sync-ui-locales.mjs           # rewrite locale files in place
//   node scripts/sync-ui-locales.mjs --check   # exit 1 if any file is stale
//
// The output mirrors `en.json`'s key ordering and 2-space indentation so diffs
// stay minimal and review-friendly.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "..", "ui", "src", "i18n", "locales");
const REFERENCE = "en.json";

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Produce a value shaped exactly like `reference`, reusing `current` wherever it
 * is structurally compatible (same type at the same path) and falling back to
 * the English `reference` otherwise.
 */
function merge(reference, current) {
  if (typeof reference === "string") {
    return typeof current === "string" ? current : reference;
  }
  if (!isPlainObject(reference)) {
    return reference;
  }
  const merged = {};
  for (const key of Object.keys(reference)) {
    const currentChild = isPlainObject(current) ? current[key] : undefined;
    merged[key] = merge(reference[key], currentChild);
  }
  return merged;
}

const referencePath = join(localesDir, REFERENCE);
const reference = JSON.parse(readFileSync(referencePath, "utf8"));

const localeFiles = readdirSync(localesDir)
  .filter((file) => file.endsWith(".json") && file !== REFERENCE)
  .sort();

const checkOnly = process.argv.includes("--check");
const stale = [];

for (const file of localeFiles) {
  const filePath = join(localesDir, file);
  const original = readFileSync(filePath, "utf8");
  const current = JSON.parse(original);
  const merged = merge(reference, current);
  const next = `${JSON.stringify(merged, null, 2)}\n`;

  if (next !== original) {
    stale.push(file);
    if (!checkOnly) {
      writeFileSync(filePath, next);
    }
  }
}

if (checkOnly) {
  if (stale.length > 0) {
    console.error(
      `Locale files are out of sync with ${REFERENCE}:\n${stale
        .map((file) => `  - ${file}`)
        .join("\n")}\nRun: node scripts/sync-ui-locales.mjs`,
    );
    process.exit(1);
  }
  console.log(`All ${localeFiles.length} locale files are in sync with ${REFERENCE}.`);
} else {
  if (stale.length > 0) {
    console.log(`Synced ${stale.length} locale file(s) with ${REFERENCE}:`);
    for (const file of stale) console.log(`  - ${file}`);
  } else {
    console.log(`All ${localeFiles.length} locale files already in sync with ${REFERENCE}.`);
  }
}
