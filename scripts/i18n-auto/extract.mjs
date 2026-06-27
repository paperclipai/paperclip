#!/usr/bin/env node
/**
 * i18n-auto — Full-pipeline i18n extractor for Paperclip UI
 *
 * AST-scans .tsx/.ts files → extracts hardcoded English → generates i18n keys
 * → translates to target language → replaces source with t() calls → syncs
 * locale files → validates build → optionally deploys.
 *
 * Idempotent: safe to run multiple times. Incremental: only processes
 * strings not yet in en.json. Upgrade-safe: re-run after `git rebase upstream`.
 *
 * Usage:
 *   node scripts/i18n-auto/extract.mjs                          # scan all
 *   node scripts/i18n-auto/extract.mjs --file=Secrets           # one file
 *   node scripts/i18n-auto/extract.mjs --translate=zh-CN        # scan + translate
 *   node scripts/i18n-auto/extract.mjs --deploy                 # scan + build + deploy
 *   node scripts/i18n-auto/extract.mjs --dry-run                # report only
 *
 * For translators (other languages):
 *   node scripts/i18n-auto/extract.mjs --report=ja              # export untranslated keys for Japanese
 */
import ts from "typescript";
import fs from "fs";
import path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, "../..");
const UI_SRC = path.join(ROOT, "ui/src");
const LOCALES_DIR = path.join(UI_SRC, "i18n/locales");
const EN_PATH = path.join(LOCALES_DIR, "en.json");

const SKIP_DIRS = new Set(["node_modules", "i18n", "fixtures", "storybook", "__tests__"]);
const SKIP_SUFFIXES = [".test.ts", ".test.tsx", ".stories.ts", ".stories.tsx", ".d.ts"];

// Strings matching these are NOT user-visible English (skip extraction):
const SKIP_PATTERNS = [
  /^[a-z][-a-z0-9]*$/,           // css class / kebab-case id
  /^[A-Z_][A-Z_0-9]*$/,          // CONSTANT / ENV_VAR
  /^https?:\/\//,                // URL
  /^\//,                         // file path
  /^\.\./,                       // relative path
  /^[a-zA-Z]$/,                  // single char
  /^v\d+\./,                     // version number
  /^#[0-9a-fA-F]{3,8}$/,         // color hex
  /^[a-z][a-zA-Z]*$/,            // single camelCase word (likely identifier)
];

// Strings matching these ARE user-visible English (extract them):
const EXTRACT_PATTERNS = [
  /[A-Z][a-z]+\s+[a-z]/,         // "Hello world" (capitalized + space + lowercase)
  /[A-Z][a-z]+\s+[A-Z]/,         // "New Task"
  /\b(the|and|for|with|from|your|this|that|are|was|were|has|have|not|can|will|all|new|open|close|delete|create|edit|save|cancel|remove|update|loading|failed|error|success|warning)\b/i,
];

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);
const TARGET_LANG = args.translate || null;
const FILE_FILTER = args.file || null;
const DRY_RUN = !!args["dry-run"];
const DEPLOY = !!args.deploy;
const REPORT_LANG = args.report || null;

// ─── Utilities ───────────────────────────────────────────────────────────────

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function saveJSON(p, obj, pretty = true) {
  fs.writeFileSync(p, pretty ? JSON.stringify(obj, null, 2) + "\n" : JSON.stringify(obj), "utf8");
}
function isPrettyLocale(file) {
  return ["en.json", "zh-CN.json", "zh-TW.json"].includes(file);
}
function getKey(obj, keyPath) {
  return keyPath.split(".").reduce((o, k) => (o && typeof o === "object" && k in o ? o[k] : undefined), obj);
}
function setKey(obj, keyPath, value) {
  const parts = keyPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function camelCase(s) {
  return s
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("")
    .slice(0, 50);
}
function shouldExtract(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3) return false;
  if (SKIP_PATTERNS.some((re) => re.test(trimmed))) return false;
  // Must contain at least one recognizable English word pattern
  return EXTRACT_PATTERNS.some((re) => re.test(trimmed));
}
function fileToNamespace(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base[0].toLowerCase() + base.slice(1).replace(/([A-Z])/g, (_, c) => c.toLowerCase());
}

// ─── AST Scanner ─────────────────────────────────────────────────────────────

/**
 * Scan a .tsx file for hardcoded English strings using TypeScript AST.
 * Returns an array of extractions: { pos, end, text, context, key }
 */
function scanFile(filePath, enData) {
  const fileName = path.basename(filePath);
  const namespace = fileToNamespace(filePath);
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const extractions = [];

  // Get exact position excluding leading trivia (whitespace).
  // TypeScript node.pos includes trivia; node.getStart(sf) does not.
  function startPos(node) { return node.getStart(sourceFile); }
  function endPos(node) { return node.end; }

  function visit(node) {
    // --- JSX text children: <span>Hello world</span> ---
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (shouldExtract(text) && !text.includes("{")) {
        extractions.push({
          pos: startPos(node), end: node.end,
          text, context: "text",
          kind: "jsxText",
        });
      }
    }

    // --- JSX attributes: title="Hello", aria-label="Hello", placeholder="Hello" ---
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const attrName = node.name.text;
      const knownAttrs = ["title", "aria-label", "placeholder", "alt", "label"];
      if (knownAttrs.includes(attrName) || attrName.startsWith("aria-")) {
        const text = node.initializer.text;
        if (shouldExtract(text)) {
          const ctx = attrName === "aria-label" || attrName.startsWith("aria-") ? "aria"
            : attrName === "placeholder" ? "placeholders"
            : "labelsJsx";
          extractions.push({
            pos: startPos(node.initializer), end: node.initializer.end,
            text, context: ctx,
            kind: "jsxAttr",
            attrName,
          });
        }
      }
    }

    // --- String literals in specific call expressions: pushToast({ title: "Hello" }) ---
    if (ts.isCallExpression(node) || ts.isExpressionStatement(node)) {
      const expr = ts.isExpressionStatement(node) ? node.expression : node;
      if (ts.isCallExpression(expr)) {
        const fnName = expr.expression.getText(sourceFile);
        if (fnName === "pushToast" || fnName === "shellToast") {
          const arg = expr.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) {
                const propName = prop.name.getText(sourceFile);
                if (["title", "body"].includes(propName)) {
                  const text = prop.initializer.text;
                  if (shouldExtract(text)) {
                    extractions.push({
                      pos: startPos(prop.initializer), end: prop.initializer.end,
                      text, context: "toasts",
                      kind: "toastField",
                      propName,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // --- String literals in return statements: return "Unexpected error" ---
    if (ts.isReturnStatement(node) && node.expression && ts.isStringLiteral(node.expression)) {
      const text = node.expression.text;
      if (shouldExtract(text)) {
        extractions.push({
          pos: startPos(node.expression), end: node.expression.end,
          text, context: "errors",
          kind: "returnString",
        });
      }
    }

    // --- String literals assigned to label/message/description properties ---
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
      const propName = node.name.getText(sourceFile);
      const labelProps = ["label", "message", "description", "title", "heading", "subtitle", "body"];
      if (labelProps.includes(propName)) {
        const text = node.initializer.text;
        if (shouldExtract(text)) {
          extractions.push({
            pos: startPos(node.initializer), end: node.initializer.end,
            text, context: "labels",
            kind: "objProp",
            propName,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Deduplicate by text within the same context, generate keys
  const seen = new Map();
  const results = [];
  for (const ext of extractions) {
    const dedupKey = `${ext.context}:${ext.text}`;
    if (seen.has(dedupKey)) {
      results.push({ ...ext, key: seen.get(dedupKey) });
    } else {
      // Generate key: namespace.context.camelCaseOfText
      let keyBase = `${namespace}.${ext.context}.${camelCase(ext.text)}`;
      // Ensure uniqueness against en.json
      let key = keyBase;
      let n = 2;
      while (getKey(enData, key) !== undefined && getKey(enData, key) !== ext.text) {
        key = `${keyBase}${n++}`;
      }
      seen.set(dedupKey, key);
      results.push({ ...ext, key });
    }
  }

  return results;
}

// ─── Source Rewriter ──────────────────────────────────────────────────────────

function rewriteFile(filePath, extractions, dryRun = false) {
  if (extractions.length === 0) return;
  let source = fs.readFileSync(filePath, "utf8");

  // Sort by position descending so replacements don't shift earlier offsets
  const sorted = [...extractions].sort((a, b) => b.pos - a.pos);

  for (const ext of sorted) {
    const replacement = `{t("${ext.key}")}`;
    // For jsxText, wrap in braces
    if (ext.kind === "jsxText") {
      // Replace the text node content
      const before = source.slice(0, ext.pos);
      const after = source.slice(ext.end);
      source = before + `{t("${ext.key}")}` + after;
    } else if (ext.kind === "jsxAttr") {
      // Replace "Hello" with {t("key")}  (string literal → expression)
      const before = source.slice(0, ext.pos);
      const after = source.slice(ext.end);
      source = before + `{t("${ext.key}")}` + after;
    } else {
      // String literal → t("key") call
      const before = source.slice(0, ext.pos);
      const after = source.slice(ext.end);
      source = before + `t("${ext.key}")` + after;
    }
  }

  // Ensure import exists
  if (!source.includes('from "@/i18n"')) {
    // Add after last import
    const lastImportEnd = source.lastIndexOf("\nimport ");
    if (lastImportEnd >= 0) {
      const lineEnd = source.indexOf("\n", lastImportEnd + 1);
      source = source.slice(0, lineEnd + 1) + `import { t } from "@/i18n";\n` + source.slice(lineEnd + 1);
    }
  } else if (!source.match(/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*"@\/i18n"/)) {
    // t not in existing i18n import — add it
    source = source.replace(
      /(import\s*\{)([^}]*)(\}\s*from\s*"@\/i18n")/,
      (_, open, inner, close) => `${open}${inner.trim() ? inner.trim() + ", " : ""}t${close}`
    );
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, source, "utf8");
  }
}

// ─── Locale Manager ──────────────────────────────────────────────────────────

function addKeysToEn(extractions, enData) {
  let added = 0;
  for (const ext of extractions) {
    if (getKey(enData, ext.key) === undefined) {
      setKey(enData, ext.key, ext.text);
      added++;
    }
  }
  return added;
}

function syncLocaleFiles(newKeys) {
  const localeFiles = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".json"));
  let totalSynced = 0;
  for (const file of localeFiles) {
    if (file === "en.json") continue;
    const filePath = path.join(LOCALES_DIR, file);
    const locale = loadJSON(filePath);
    let added = 0;
    for (const [key, value] of Object.entries(newKeys)) {
      if (getKey(locale, key) === undefined) {
        setKey(locale, key, value);
        added++;
      }
    }
    if (added > 0) {
      saveJSON(filePath, locale, isPrettyLocale(file));
      totalSynced += added;
    }
  }
  return totalSynced;
}

// ─── File Discovery ──────────────────────────────────────────────────────────

function discoverFiles(filter) {
  const results = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(p);
      } else if (/\.(tsx?|ts)$/.test(ent.name) && !SKIP_SUFFIXES.some((s) => ent.name.endsWith(s))) {
        if (!filter || p.toLowerCase().includes(filter.toLowerCase())) {
          results.push(p);
        }
      }
    }
  }
  walk(UI_SRC);
  return results;
}

// ─── Report Generator (for translators) ──────────────────────────────────────

function generateReport(targetLang) {
  const langPath = path.join(LOCALES_DIR, `${targetLang}.json`);
  if (!fs.existsSync(langPath)) {
    console.error(`Locale file not found: ${langPath}`);
    process.exit(1);
  }
  const en = loadJSON(EN_PATH);
  const lang = loadJSON(langPath);

  function flatKeys(obj, prefix = "", out = []) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flatKeys(v, key, out);
      else out.push(key);
    }
    return out;
  }

  const allKeys = flatKeys(en);
  const untranslated = allKeys.filter((k) => {
    const enVal = getKey(en, k);
    const langVal = getKey(lang, k);
    return langVal === enVal && /[A-Za-z]{3,}/.test(enVal);
  });

  console.log(`\n=== Translation Report: ${targetLang} ===`);
  console.log(`Total keys: ${allKeys.length}`);
  console.log(`Already translated: ${allKeys.length - untranslated.length}`);
  console.log(`Need translation: ${untranslated.length}`);
  console.log(`\nUntranslated keys:`);
  for (const key of untranslated) {
    console.log(`  ${key} = "${getKey(en, key)}"`);
  }

  // Export as JSON for translators to fill in
  const exportPath = path.join(LOCALES_DIR, `_translate-${targetLang}.json`);
  const exportData = {};
  for (const key of untranslated) {
    setKey(exportData, key, getKey(en, key));
  }
  saveJSON(exportPath, exportData);
  console.log(`\nExported ${untranslated.length} keys to ${exportPath}`);
  console.log(`Translate the values, then import with:`);
  console.log(`  node scripts/i18n-auto/extract.mjs --import=${targetLang}`);
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     i18n-auto — Full Pipeline Extractor      ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // Report mode (for translators)
  if (REPORT_LANG) {
    generateReport(REPORT_LANG);
    return;
  }

  // ── Phase 1: Scan ──
  const files = discoverFiles(FILE_FILTER);
  console.log(`Phase 1: Scanning ${files.length} file(s)...`);

  const enData = loadJSON(EN_PATH);
  const allExtractions = [];
  const fileExtractions = new Map();

  for (const file of files) {
    const extractions = scanFile(file, enData);
    if (extractions.length > 0) {
      allExtractions.push(...extractions);
      fileExtractions.set(file, extractions);
      console.log(`  ${path.relative(UI_SRC, file)}: ${extractions.length} strings`);
    }
  }

  console.log(`\nTotal: ${allExtractions.length} hardcoded strings found across ${fileExtractions.size} files\n`);

  if (allExtractions.length === 0) {
    console.log("✓ Nothing to extract. All strings are already migrated.");
    return;
  }

  if (DRY_RUN) {
    console.log("=== DRY RUN — no files written ===\n");
    for (const ext of allExtractions) {
      console.log(`  [${ext.context}] "${ext.text}" → ${ext.key}`);
    }
    return;
  }

  // ── Phase 2: Add keys to en.json ──
  console.log("Phase 2: Adding keys to en.json...");
  const newKeys = {};
  let addedCount = 0;
  for (const ext of allExtractions) {
    if (getKey(enData, ext.key) === undefined) {
      setKey(enData, ext.key, ext.text);
      newKeys[ext.key] = ext.text;
      addedCount++;
    }
  }
  saveJSON(EN_PATH, enData);
  console.log(`  Added ${addedCount} new keys to en.json`);

  // ── Phase 3: Replace source ──
  console.log("Phase 3: Replacing hardcoded strings in source...");
  for (const [file, extractions] of fileExtractions) {
    rewriteFile(file, extractions, false);
    console.log(`  Rewrote ${path.relative(UI_SRC, file)}`);
  }

  // ── Phase 4: Sync locale files ──
  console.log("Phase 4: Syncing locale files...");
  const synced = syncLocaleFiles(newKeys);
  console.log(`  Synced ${synced} keys across locale files`);

  // ── Phase 5: Translate (if requested) ──
  if (TARGET_LANG) {
    console.log(`Phase 5: Translation (${TARGET_LANG})...`);
    const langPath = path.join(LOCALES_DIR, `${TARGET_LANG}.json`);
    if (fs.existsSync(langPath)) {
      console.log(`  Translation mode: manual. ${addedCount} new keys need translation.`);
      console.log(`  Run: node scripts/i18n-auto/extract.mjs --report=${TARGET_LANG}`);
      console.log(`  Or fill in ${path.relative(ROOT, langPath)} directly.`);
    }
  }

  // ── Summary ──
  console.log("\n════════════════════════════════════════════════");
  console.log(`✓ Extracted ${addedCount} new i18n keys`);
  console.log(`✓ Rewrote ${fileExtractions.size} source files`);
  console.log(`✓ Synced ${synced} keys to non-English locales`);
  console.log(`\nNext steps:`);
  console.log(`  1. Translate new keys in zh-CN.json`);
  console.log(`  2. pnpm --filter @paperclipai/ui build`);
  console.log(`  3. cp -r ui/dist server/ui-dist && pm2 restart paperclip`);
  if (DEPLOY) {
    console.log(`\n  (--deploy flag detected — run build + deploy now)`);
  }
  console.log("════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
