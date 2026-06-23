#!/usr/bin/env node
// Populate i18next plural resource keys (`<key>_one` / `<key>_other`) for every
// page `t()` call that uses native pluralization (a `defaultValue_one` /
// `defaultValue_other` / `defaultValue_plural` variant).
//
// Why this is needed: i18next, given a `count`, resolves `<key>_one`/`<key>_other`
// from the *resource* (en.json) and only falls back to `defaultValue_*` when the
// resource key is missing. The bulk localization staged only the BASE key, so the
// base value shadows plural lookup and every count renders the singular form
// ("3 agent"). This script reads the English singular/plural straight from the
// source and reuses the already-merged Simplified-Chinese base translation for the
// Chinese plural forms (Chinese has a single plural category).
//
// Usage: node scripts/fix-plural-locales.mjs
// After this, run: node scripts/sync-ui-locales.mjs

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const srcDir = join(repoRoot, "ui", "src");
// Scan every UI surface that holds localized `t()` calls (recursively).
const SCAN_ROOTS = ["pages", "components", "plugins"].map((d) => join(srcDir, d));
const localesDir = join(repoRoot, "ui", "src", "i18n", "locales");
const enPath = join(localesDir, "en.json");
const zhPath = join(localesDir, "zh-CN.json");

const PLURAL_PROPS = ["_one", "_other", "_plural", "_two", "_few", "_many", "_zero"];

function parseLiteral(lit) {
  const quote = lit[0];
  if (quote === '"') {
    try {
      return JSON.parse(lit);
    } catch {
      /* fall through to manual */
    }
  }
  return lit.slice(1, -1).replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
}

// String-aware scan: returns [{ key, optsText }] for every `t("key", { ... })`.
function scanTCalls(src) {
  const calls = [];
  const re = /\bt\(\s*(["'`])/g;
  let m;
  while ((m = re.exec(src))) {
    const quote = m[1];
    let i = m.index + m[0].length; // first char of the key body
    let key = "";
    let ok = true;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        key += src[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        break;
      }
      key += c;
      i++;
    }
    if (quote === "`" && key.includes("${")) ok = false; // dynamic key — skip
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== ",") continue;
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "{") continue;
    let depth = 0;
    let inStr = null;
    const objStart = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    if (ok) calls.push({ key, optsText: src.slice(objStart, i) });
  }
  return calls;
}

// Parse ONLY the top-level properties of an options object literal. Nested
// `t(...)` calls (e.g. `runs: t("k", { defaultValue_other: ... })`) live inside
// parentheses/braces and must NOT contribute their `defaultValue_other` to the
// outer key — otherwise a non-plural outer call gets a spurious plural form with
// mismatched placeholders. Returns the top-level `defaultValue*` strings plus
// whether a top-level `count` is present (i18next requires `count` to pluralize).
function extractDefaults(opts) {
  const out = {};
  let hasCount = false;
  let i = 1; // skip the outer "{"
  let depth = 0; // nesting depth beyond the top level
  let inStr = null;
  const n = opts.length;
  const readString = (start) => {
    const quote = opts[start];
    let k = start + 1;
    let raw = quote;
    while (k < n) {
      raw += opts[k];
      if (opts[k] === "\\") {
        raw += opts[k + 1];
        k += 2;
        continue;
      }
      if (opts[k] === quote) {
        k++;
        break;
      }
      k++;
    }
    return { raw, end: k };
  };
  while (i < n) {
    const c = opts[i];
    if (inStr) {
      if (c === "\\") { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; i++; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; i++; continue; }
    if (depth === 0) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(opts.slice(i));
      if (m) {
        const key = m[1];
        let j = i + m[0].length;
        while (j < n && /\s/.test(opts[j])) j++;
        if (key === "count") hasCount = true;
        if (/^defaultValue(_one|_other|_plural|_two|_few|_many|_zero)?$/.test(key)) {
          const ch = opts[j];
          if (ch === '"' || ch === "'" || ch === "`") {
            const { raw, end } = readString(j);
            if (!(ch === "`" && raw.includes("${"))) out[key] = parseLiteral(raw);
            i = end;
            continue;
          }
        }
        i = j;
        continue;
      }
    }
    i++;
  }
  out.__hasCount = hasCount;
  return out;
}

function getDeep(root, dottedKey) {
  let node = root;
  for (const part of dottedKey.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

function setDeep(root, dottedKey, value) {
  const parts = dottedKey.split(".");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

const en = JSON.parse(readFileSync(enPath, "utf8"));
const zh = JSON.parse(readFileSync(zhPath, "utf8"));

function walkTsx(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsx(full));
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx") && !entry.endsWith(".stories.tsx")) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = SCAN_ROOTS.flatMap((root) => walkTsx(root));
const fixed = [];
const warnings = [];

for (const fullPath of sourceFiles) {
  const file = fullPath.slice(srcDir.length + 1);
  const src = readFileSync(fullPath, "utf8");
  for (const { key, optsText } of scanTCalls(src)) {
    const defaults = extractDefaults(optsText);
    const hasPlural = PLURAL_PROPS.some((suffix) => `defaultValue${suffix}` in defaults);
    // Require a top-level `count` (i18next pluralizes on it) so calls that merely
    // *contain* a nested plural t() are not mistaken for plural calls themselves.
    if (!hasPlural || !defaults.__hasCount) continue;

    const enOne = defaults.defaultValue_one ?? defaults.defaultValue ?? defaults.defaultValue_other;
    const enOther = defaults.defaultValue_other ?? defaults.defaultValue_plural ?? defaults.defaultValue ?? enOne;
    if (typeof enOne !== "string" || typeof enOther !== "string") {
      warnings.push(`${file}: ${key} — could not resolve english singular/plural`);
      continue;
    }

    // Prefer translations that already exist (an agent may have staged the
    // plural-suffixed keys directly, or the base key carries the singular). Only
    // fall back to the English plural when there is no Chinese to reuse.
    const asString = (value) => (typeof value === "string" ? value : undefined);
    const zhExistingOther = asString(getDeep(zh, `${key}_other`));
    const zhExistingOne = asString(getDeep(zh, `${key}_one`));
    const zhBase = asString(getDeep(zh, key));
    const zhOther = zhExistingOther ?? zhBase ?? enOther;
    const zhOne = zhExistingOne ?? zhBase ?? zhOther;
    if (zhExistingOther === undefined && zhBase === undefined) {
      warnings.push(`${file}: ${key} — no merged zh translation; falling back to english plural`);
    }

    setDeep(en, `${key}_one`, enOne);
    setDeep(en, `${key}_other`, enOther);
    setDeep(zh, `${key}_one`, zhOne);
    setDeep(zh, `${key}_other`, zhOther);
    fixed.push(key);
  }
}

writeFileSync(enPath, `${JSON.stringify(en, null, 2)}\n`);
writeFileSync(zhPath, `${JSON.stringify(zh, null, 2)}\n`);

const unique = [...new Set(fixed)];
console.log(`Pluralized resource keys generated for ${unique.length} base keys:`);
for (const key of unique.sort()) console.log(`  - ${key}`);
if (warnings.length > 0) {
  console.log(`\nWarnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
console.log(`\nUpdated en.json + zh-CN.json. Next: node scripts/sync-ui-locales.mjs`);
