#!/usr/bin/env node
// Checks the i18n extraction result in ui/src/pages:
// - every .tsx file parses,
// - every t("key") call in pages resolves to a key in locales/en.json,
// - prints file, call and key counts.
//
// Usage (from ui/): node scripts/i18n-check.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "..");
const PAGES_DIR = join(UI_ROOT, "src", "pages");
const EN_PATH = join(UI_ROOT, "src", "i18n", "locales", "en.json");

function listTsx(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsx(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out.sort();
}

function leaves(obj, prefix = "") {
  const out = new Set();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.add(key);
    else if (v && typeof v === "object") for (const x of leaves(v, key)) out.add(x);
  }
  return out;
}

const enKeys = leaves(JSON.parse(readFileSync(EN_PATH, "utf8")));
const files = listTsx(PAGES_DIR);
let parseErrors = 0;
let calls = 0;
let filesWithCalls = 0;
const usedKeys = new Set();
const unknownKeys = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  try {
    parseAst(text, { lang: "tsx", sourceType: "module", filename: file });
  } catch (err) {
    parseErrors++;
    console.log(`PARSE FAIL ${relative(UI_ROOT, file)}: ${err.message}`);
  }
  let inFile = 0;
  for (const m of text.matchAll(/\bt\("([^"]+)"\)/g)) {
    inFile++;
    usedKeys.add(m[1]);
    if (!enKeys.has(m[1])) unknownKeys.push(`${relative(UI_ROOT, file)}: ${m[1]}`);
  }
  if (inFile > 0) filesWithCalls++;
  calls += inFile;
}

console.log(`files scanned:        ${files.length}`);
console.log(`files with t() calls: ${filesWithCalls}`);
console.log(`files with errors:    ${parseErrors}`);
console.log(`t() calls:            ${calls}`);
console.log(`distinct keys used:   ${usedKeys.size}`);
console.log(`en.json keys:         ${enKeys.size}`);
for (const k of unknownKeys.slice(0, 20)) console.log(`UNKNOWN KEY ${k}`);
process.exit(parseErrors === 0 && unknownKeys.length === 0 ? 0 : 1);
