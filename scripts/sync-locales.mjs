#!/usr/bin/env node
/**
 * Checks or scaffolds the reviewed Russian catalog against en.json.
 *
 * en.json is the source of truth for keys and structure. The default mode is
 * read-only and fails when ru.json is out of sync. Pass --write to add missing
 * keys with their English source text and remove obsolete keys; every inserted
 * source string is printed so it can be translated before committing.
 *
 * Run after adding or removing keys from en.json:
 *
 *   node scripts/sync-locales.mjs
 *   node scripts/sync-locales.mjs --write
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const localesDir = join(rootDir, "ui", "src", "i18n", "locales");
const englishPath = join(localesDir, "en.json");
const russianPath = join(localesDir, "ru.json");
const write = process.argv.includes("--write");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function syncValue(candidate, english, path = [], missing = []) {
  if (typeof english === "string") {
    if (typeof candidate === "string") return candidate;
    missing.push(path.join("."));
    return english;
  }
  if (Array.isArray(english)) {
    return Array.isArray(candidate) ? candidate : english;
  }
  if (isPlainObject(english)) {
    const output = {};
    for (const key of Object.keys(english)) {
      output[key] = syncValue(
        isPlainObject(candidate) ? candidate[key] : undefined,
        english[key],
        [...path, key],
        missing,
      );
    }
    return output;
  }
  return english;
}

const english = JSON.parse(readFileSync(englishPath, "utf8"));
const russian = JSON.parse(readFileSync(russianPath, "utf8"));
const missing = [];
const synced = syncValue(russian, english, [], missing);
const changed = JSON.stringify(synced) !== JSON.stringify(russian);

if (write) {
  writeFileSync(russianPath, `${JSON.stringify(synced, null, 2)}\n`);
  if (missing.length > 0) {
    console.log("Added English source text for these Russian keys:");
    for (const key of missing) console.log(`- ${key}`);
    console.log("Translate every listed value before committing.");
  } else if (changed) {
    console.log("Removed obsolete Russian keys; no source keys were missing.");
  } else {
    console.log("ru.json is already in sync with en.json.");
  }
  process.exit(0);
}

if (changed) {
  console.error("ru.json is out of sync with en.json.");
  if (missing.length > 0) {
    console.error("Missing Russian keys:");
    for (const key of missing) console.error(`- ${key}`);
  }
  console.error("Run `node scripts/sync-locales.mjs --write`, translate the listed source text, then rerun this check.");
  process.exit(1);
}

console.log("ru.json is in exact key parity with en.json.");
