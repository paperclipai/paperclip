#!/usr/bin/env node
/**
 * Syncs every locale file under ui/src/i18n/locales with en.json.
 *
 * en.json is the single source of truth for the set of keys (and their
 * structure/interpolation placeholders). For every other locale this script:
 *   - fills in keys that are missing using the English value (English fallback)
 *   - drops keys that are not defined in English
 *   - preserves any existing translation values for keys that already exist
 *
 * Run after adding or removing keys from en.json:
 *
 *   node scripts/sync-locales.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const localesDir = join(rootDir, "ui", "src", "i18n", "locales");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function syncValue(candidate, english) {
  if (typeof english === "string") {
    return typeof candidate === "string" ? candidate : english;
  }
  if (Array.isArray(english)) {
    return Array.isArray(candidate) ? candidate : english;
  }
  if (isPlainObject(english)) {
    const output = {};
    for (const key of Object.keys(english)) {
      output[key] = syncValue(isPlainObject(candidate) ? candidate[key] : undefined, english[key]);
    }
    return output;
  }
  return english;
}

const englishRaw = readFileSync(join(localesDir, "en.json"), "utf8");
const english = JSON.parse(englishRaw);
const localeFiles = readdirSync(localesDir)
  .filter((file) => /\.json$/.test(file))
  .filter((file) => file !== "en.json");

for (const file of localeFiles) {
  const filePath = join(localesDir, file);
  const candidate = JSON.parse(readFileSync(filePath, "utf8"));
  const synced = syncValue(candidate, english);
  writeFileSync(filePath, `${JSON.stringify(synced, null, 2)}\n`);
  const missing = countMissing(synced, english);
  console.log(`${file}: synced${missing > 0 ? ` (${missing} keys fell back to English)` : ""}`);
}

function countMissing(candidate, english) {
  let missing = 0;
  if (typeof english === "string") {
    return typeof candidate === "string" && candidate === english ? 1 : 0;
  }
  if (isPlainObject(english)) {
    for (const key of Object.keys(english)) {
      missing += countMissing(isPlainObject(candidate) ? candidate[key] : undefined, english[key]);
    }
  }
  return missing;
}

console.log("All locales synced with en.json.");
