#!/usr/bin/env node
/**
 * Checks or scaffolds a catalog against en.json and its own CLDR plural rules.
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
 *   node scripts/sync-locales.mjs --locale de --write
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localeKeyReferences, localeReferenceKey } from "../ui/src/i18n/locale-structure.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const localesDir = join(rootDir, "ui", "src", "i18n", "locales");
const englishPath = join(localesDir, "en.json");
const localeArg = process.argv.indexOf("--locale");
const locale = localeArg < 0 ? "ru" : process.argv[localeArg + 1];
if (!locale || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) || locale === "en") {
  throw new Error("--locale must name a target locale, for example ru or pt-BR.");
}
const targetPath = join(localesDir, `${locale}.json`);
const write = process.argv.includes("--write");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function syncValue(candidate, english, path = [], missing = [], errors = []) {
  if (typeof english === "string") {
    if (typeof candidate === "string") {
      const placeholders = (text) => [...text.matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g)].map((match) => match[1]).sort().join("\0");
      if (placeholders(candidate) !== placeholders(english)) errors.push(`${path.join(".")}: interpolation placeholders differ`);
      return candidate;
    }
    missing.push(path.join("."));
    return english;
  }
  if (Array.isArray(english)) {
    return Array.isArray(candidate) ? candidate : english;
  }
  if (isPlainObject(english)) {
    const output = {};
    const references = localeKeyReferences(english, locale);
    if (isPlainObject(candidate)) {
      for (const key of Object.keys(candidate)) {
        const referenceKey = localeReferenceKey(key, english);
        if (referenceKey !== null && !references.has(key)) references.set(key, referenceKey);
      }
    }
    for (const [key, referenceKey] of references) {
      output[key] = syncValue(
        isPlainObject(candidate) ? candidate[key] : undefined,
        english[referenceKey],
        [...path, key],
        missing,
        errors,
      );
    }
    return output;
  }
  return english;
}

const english = JSON.parse(readFileSync(englishPath, "utf8"));
if (!existsSync(targetPath) && !write) {
  console.error(`${locale}.json does not exist. Use --locale ${locale} --write to scaffold it, then translate every source string.`);
  process.exit(1);
}
const target = existsSync(targetPath) ? JSON.parse(readFileSync(targetPath, "utf8")) : {};
const missing = [];
const errors = [];
const synced = syncValue(target, english, [], missing, errors);
function canonical(value) {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const changed = JSON.stringify(canonical(synced)) !== JSON.stringify(canonical(target));

if (write) {
  writeFileSync(targetPath, `${JSON.stringify(synced, null, 2)}\n`);
  if (missing.length > 0) {
    console.log(`Added English source text for these ${locale} keys:`);
    for (const key of missing) console.log(`- ${key}`);
    console.log("Translate every listed value before committing.");
  } else if (changed) {
    console.log(`Removed obsolete ${locale} keys; no source keys were missing.`);
  } else {
    console.log(`${locale}.json is already in sync with en.json.`);
  }
  for (const error of errors) console.error(error);
  process.exit(errors.length > 0 ? 1 : 0);
}

if (changed || errors.length > 0) {
  console.error(`${locale}.json is out of sync with en.json.`);
  if (missing.length > 0) {
    console.error(`Missing ${locale} keys:`);
    for (const key of missing) console.error(`- ${key}`);
  }
  for (const error of errors) console.error(error);
  console.error(`Run node scripts/sync-locales.mjs --locale ${locale} --write, translate the listed source text, then rerun this check.`);
  process.exit(1);
}

console.log(`${locale}.json has complete message coverage and valid interpolation placeholders for ${locale} plural forms.`);
