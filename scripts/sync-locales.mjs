#!/usr/bin/env node
/**
 * Sync every locale file to the English key structure.
 *
 * English (en.json) is the source of truth for the key tree. For each other
 * locale this script:
 *   - keeps existing translations (never overwrites them),
 *   - fills any missing key with the English string (UI falls back to it),
 *   - removes keys that no longer exist in English (the locale validator
 *     rejects them).
 *
 * Usage (from the repo root):
 *   node scripts/sync-locales.mjs          # write the synchronized files
 *   node scripts/sync-locales.mjs --check  # report only; exit 1 when out of sync
 *
 * This is the maintenance routine after any upstream change adds or removes
 * UI copy: run `pnpm locales:sync` once, then translate only the new keys in
 * zh-CN.json (and zh-TW.json if desired). Do NOT hand-edit the other 38
 * locale files - they are mirrors of en.json by construction.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = path.join(root, "ui", "src", "i18n", "locales");
const checkOnly = process.argv.includes("--check");

const en = JSON.parse(fs.readFileSync(path.join(localesDir, "en.json"), "utf8"));

/** Deep merge: keep existing leaf values, add missing leaves (English fallback), drop extras. */
function syncTree(reference, current, localeName, prefix, report) {
  const out = {};
  for (const [key, refValue] of Object.entries(reference)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const curValue = current?.[key];
    if (typeof refValue === "object" && refValue !== null) {
      const sub = syncTree(refValue, curValue, localeName, fullKey, report);
      if (Object.keys(sub).length > 0) out[key] = sub;
    } else {
      if (curValue === undefined) {
        report.added.push(fullKey);
        out[key] = refValue; // English fallback until translated
      } else {
        out[key] = curValue; // keep the existing translation
      }
    }
  }
  if (current && typeof current === "object") {
    for (const key of Object.keys(current)) {
      if (!(key in reference)) {
        report.removed.push(prefix ? `${prefix}.${key}` : key);
      }
    }
  }
  return out;
}

const localeFiles = fs
  .readdirSync(localesDir)
  .filter((f) => f.endsWith(".json") && f !== "en.json")
  .sort();

let anyDrift = false;
let totalAdded = 0;
let totalRemoved = 0;
const summary = [];

for (const file of localeFiles) {
  const filePath = path.join(localesDir, file);
  const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const localeName = file.replace(/\.json$/, "");
  const report = { added: [], removed: [] };
  const synced = syncTree(en, current, localeName, "", report);

  if (report.added.length > 0 || report.removed.length > 0) {
    anyDrift = true;
    totalAdded += report.added.length;
    totalRemoved += report.removed.length;
    summary.push(
      `${localeName}: +${report.added.length} missing (English fallback), -${report.removed.length} extra`,
    );
    if (!checkOnly) {
      fs.writeFileSync(filePath, JSON.stringify(synced, null, 2) + "\n", "utf8");
    }
  }
}

if (anyDrift) {
  console.log(summary.join("\n"));
  console.log(
    checkOnly
      ? `\nLOCALES OUT OF SYNC (+${totalAdded} missing, -${totalRemoved} extra). Run: node scripts/sync-locales.mjs`
      : `\nSynced ${localeFiles.length} locale files (+${totalAdded} filled, -${totalRemoved} removed). Translate the new keys in zh-CN.json next.`,
  );
  if (checkOnly) process.exitCode = 1;
} else {
  console.log(`All ${localeFiles.length} locale files are in sync with en.json.`);
}
