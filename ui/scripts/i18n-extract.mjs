#!/usr/bin/env node
// Moves UI copy from ui/src/pages/**/*.tsx into the i18n catalog.
//
// - JSX text with a 3+ letter Latin word          -> {t("<file-slug>.<text-slug>")}
// - String attributes placeholder, title, aria-label,
//   label, description, tooltip                    -> {t("...")}
// - Adds `import { t } from "@/i18n";` where needed
// - Writes ui/src/i18n/locales/en.json (existing keys kept, new keys added)
//
// The parser is the one vite ships (oxc), so the script adds no dependency.
// The script edits files by source positions. Text outside the replaced
// spans does not change. A file that does not parse after the change is
// left untouched and reported.
//
// Usage (from ui/, after pnpm install):
//   node scripts/i18n-extract.mjs [--dry] [file...]

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "..");
const PAGES_DIR = join(UI_ROOT, "src", "pages");
const EN_PATH = join(UI_ROOT, "src", "i18n", "locales", "en.json");
const SKIP_PATH = join(HERE, "i18n-skip.json");

// Per-file strings to keep as literals (see i18n-skip.json).
const skipByFile = new Map(
  Object.entries(JSON.parse(readFileSync(SKIP_PATH, "utf8")))
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [resolve(UI_ROOT, k), new Set(v)]),
);

const dry = process.argv.includes("--dry");
const explicit = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// ---------------------------------------------------------------- constants

const I18N_IMPORT = 'import { t } from "@/i18n";';
const ATTR_NAMES = new Set(["placeholder", "title", "aria-label", "label", "description", "tooltip"]);
// Never translate inside these JSX elements.
const SKIP_ANCESTOR_TAGS = new Set(["code", "pre", "script", "style"]);
// JSX text fragments that are pure punctuation between expressions.
const SKIP_TEXTS = new Set(["—", "–", "-", "– ", " —", ":", " · ", "•", "/", "|", "(", ")", "[]"]);

// ---------------------------------------------------------------- helpers

const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-zA-Z]*)+\b/;
const SNAKE_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/;
const KEBAB_RE = /\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/;
const HAS_WORD_RE = /[A-Za-z]{3,}/;

function isIdentifierLike(text) {
  const s = text.trim();
  if (!s) return true;
  if (CAMEL_RE.test(s) || SNAKE_RE.test(s) || KEBAB_RE.test(s)) return true;
  if (/^[a-z][a-z0-9]*$/.test(s)) return true; // single lowercase word: variable, css token
  if (/^\//.test(s) || /^\.{1,2}\//.test(s)) return true; // path
  if (!/\s/.test(s) && /\.[a-zA-Z]{1,5}$/.test(s)) return true; // file name
  if (/^[A-Z][A-Z0-9_]*$/.test(s)) return true; // CONSTANT
  return false;
}

function urlOrPathLike(text) {
  const s = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^mailto:|^tel:/i.test(s)) return true;
  if (/^\/[\w./?=&%-]*$/.test(s)) return true;
  return false;
}

// Same rule as the JSX transform: lines are trimmed, empty lines dropped,
// remaining lines joined with one space.
function jsxCollapse(text) {
  if (!text.includes("\n")) return text;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

function isTranslatable(text) {
  if (!text || text.trim().length === 0) return false;
  if (/&[a-z]+;/i.test(text)) return false; // an entity this script does not know

  if (SKIP_TEXTS.has(text)) return false;
  if (!HAS_WORD_RE.test(text)) return false;
  if (urlOrPathLike(text)) return false;
  if (isIdentifierLike(text)) return false;
  return true;
}

const RESERVED_SEG = /^(true|false|null|undefined|new|typeof|function|return|if|else)$/;

function slugifyFile(file) {
  const base = basename(file, ".tsx").replace(/\.test$/, "");
  let slug = base
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "page";
  if (RESERVED_SEG.test(slug)) slug += "-page";
  return slug;
}

// FNV-1a, 3 base-36 characters: keeps equal slugs of different texts apart
// and makes a re-run produce the same key for the same text.
function hash3(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 3);
}

function slugifyText(text) {
  const base = text
    .trim()
    .replace(/([a-z0-9])([A-Z])([a-z])/g, "$1-$2$3")
    .toLowerCase()
    // "." nests keys and ":" separates namespaces in i18next, so neither may
    // appear in a key segment.
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  return `${base || "text"}-${hash3(text)}`;
}

// ---------------------------------------------------------------- catalog

const en = JSON.parse(readFileSync(EN_PATH, "utf8"));

function getNested(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function setNested(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const keysByFile = new Map(); // fileSlug -> Map(key -> text)
function makeKey(fileSlug, text) {
  if (!keysByFile.has(fileSlug)) keysByFile.set(fileSlug, new Map());
  const reg = keysByFile.get(fileSlug);
  const base = slugifyText(text);
  let key = base;
  let n = 2;
  while (reg.has(key) && reg.get(key) !== text) key = `${base}-${n++}`;
  if (!reg.has(key)) {
    const existing = getNested(en, `${fileSlug}.${key}`.split("."));
    if (existing !== undefined && existing !== text) {
      while (getNested(en, `${fileSlug}.${key}`.split(".")) !== undefined) key = `${base}-${n++}`;
    }
    reg.set(key, text);
    if (getNested(en, `${fileSlug}.${key}`.split(".")) === undefined) {
      setNested(en, `${fileSlug}.${key}`.split("."), text);
    }
  }
  return `${fileSlug}.${key}`;
}

// ---------------------------------------------------------------- transform

function parseTsx(code, file) {
  return parseAst(code, { lang: "tsx", sourceType: "module", filename: file });
}

// JSX decodes HTML entities in text at compile time; t() does not. The
// catalog stores decoded text. Named entities: the set JSX text uses in
// this codebase plus the HTML basics; a numeric reference is decoded as is.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  middot: "·", bull: "•", hellip: "…", mdash: "—", ndash: "–",
  rarr: "→", larr: "←", uarr: "↑", darr: "↓", times: "×", copy: "©", reg: "®",
  trade: "™", deg: "°", laquo: "«", raquo: "»", ldquo: "\u201c", rdquo: "\u201d",
  lsquo: "\u2018", rsquo: "\u2019", check: "✓",
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, ref) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      const code = parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref] ?? match;
  });
}

function walk(node, visit, ancestors) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === "string") walk(c, visit, ancestors);
    } else if (child && typeof child.type === "string") {
      walk(child, visit, ancestors);
    }
  }
  ancestors.pop();
}

function jsxTagName(node) {
  const n = node.name;
  if (!n) return "";
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") return `${jsxTagName({ name: n.object })}.${n.property.name}`;
  if (n.type === "JSXNamespacedName") return `${n.namespace.name}:${n.name.name}`;
  return "";
}

function insideSkippedTag(ancestors) {
  for (const a of ancestors) {
    if (a.type === "JSXElement" && SKIP_ANCESTOR_TAGS.has(jsxTagName(a.openingElement))) return true;
  }
  return false;
}

// End offset of the last top-level import declaration, or -1.
function importBlockEnd(ast) {
  let end = -1;
  for (const stmt of ast.body) {
    if (stmt.type === "ImportDeclaration") end = stmt.end;
  }
  return end;
}

function transformFile(file) {
  // "*" in i18n-skip.json keeps the whole file as it is.
  if (skipByFile.get(file)?.has("*")) return { file, skipped: false, replacements: 0, skippedCount: 0, unchanged: true };
  const original = readFileSync(file, "utf8");
  let ast;
  try {
    ast = parseTsx(original, file);
  } catch (err) {
    return { file, skipped: true, reason: `does not parse: ${err.message}`, replacements: 0 };
  }
  const fileSlug = slugifyFile(file);
  const keep = skipByFile.get(file) ?? new Set();
  const edits = []; // { start, end, text }
  let skippedCount = 0;

  walk(
    ast,
    (node, ancestors) => {
      if (node.type === "JSXText") {
        if (insideSkippedTag(ancestors)) {
          skippedCount++;
          return;
        }
        const value = original.slice(node.start, node.end);
        const leading = value.match(/^\s*/)[0];
        const trailing = value.match(/\s*$/)[0];
        // JSX collapses line breaks and their indentation to one space.
        // The catalog stores the text as the browser shows it.
        const core = decodeEntities(jsxCollapse(value.slice(leading.length, value.length - trailing.length)));
        if (core.length > 0 && isTranslatable(core) && !keep.has(core)) {
          const key = makeKey(fileSlug, core);
          edits.push({ start: node.start, end: node.end, text: `${leading}{t("${key}")}${trailing}` });
        } else if (core.length > 0 && !SKIP_TEXTS.has(core)) {
          skippedCount++;
        }
        return;
      }
      if (node.type === "JSXAttribute" && node.value && (node.value.type === "StringLiteral" || node.value.type === "Literal")) {
        const attrName = node.name.type === "JSXNamespacedName"
          ? `${node.name.namespace.name}:${node.name.name.name}`
          : node.name.name;
        if (!ATTR_NAMES.has(attrName)) return;
        const raw = decodeEntities(original.slice(node.value.start + 1, node.value.end - 1));
        if (isTranslatable(raw) && !keep.has(raw)) {
          const key = makeKey(fileSlug, raw);
          edits.push({ start: node.value.start, end: node.value.end, text: `{t("${key}")}` });
        } else {
          skippedCount++;
        }
      }
    },
    [],
  );

  if (edits.length === 0) return { file, skipped: false, replacements: 0, skippedCount, unchanged: true };

  edits.sort((a, b) => b.start - a.start);
  let out = original;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  if (!/from\s+["']@\/i18n["']/.test(out)) {
    const at = importBlockEnd(ast);
    // Positions before the first edit are unchanged, so `at` is still valid.
    out = at >= 0 ? `${out.slice(0, at)}\n${I18N_IMPORT}${out.slice(at)}` : `${I18N_IMPORT}\n${out}`;
  }

  try {
    parseTsx(out, file);
  } catch (err) {
    return { file, skipped: true, reason: `does not parse after transform: ${err.message}`, replacements: 0 };
  }

  if (!dry) writeFileSync(file, out, "utf8");
  return { file, skipped: false, replacements: edits.length, skippedCount };
}

// ---------------------------------------------------------------- main

function listPages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listPages(p));
    // Test files assert on literal UI text. They are not extracted.
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(p);
  }
  return out.sort();
}

const files = explicit.length > 0 ? explicit.map((f) => resolve(f)) : listPages(PAGES_DIR);

let totalReplacements = 0;
let totalSkipped = 0;
let touched = 0;
const broken = [];

for (const f of files) {
  const rel = relative(UI_ROOT, f);
  let r;
  try {
    r = transformFile(f);
  } catch (err) {
    broken.push(`${rel}: ${err && err.message}`);
    continue;
  }
  if (r.skipped) broken.push(`${rel}: ${r.reason}`);
  else if (!r.unchanged) {
    touched++;
    totalReplacements += r.replacements;
    totalSkipped += r.skippedCount || 0;
  }
}

function countLeaves(obj) {
  let n = 0;
  for (const v of Object.values(obj)) {
    if (typeof v === "string") n++;
    else if (v && typeof v === "object") n += countLeaves(v);
  }
  return n;
}

if (!dry) writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + "\n", "utf8");

console.log(
  JSON.stringify(
    {
      filesScanned: files.length,
      filesTouched: touched,
      replacements: totalReplacements,
      skippedStrings: totalSkipped,
      enLeaves: countLeaves(en),
      brokenFiles: broken.length,
    },
    null,
    2,
  ),
);
for (const b of broken) console.log("  " + b);
process.exit(broken.length === 0 ? 0 : 1);
