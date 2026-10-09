#!/usr/bin/env node
/**
 * codemod-extract-type.mjs
 *
 * Phase 2 (extraction), Batch 2/4 of the design-token audit
 * (branch design/token-extraction). Replaces hardcoded TYPE values —
 * arbitrary Tailwind font-size (`text-[11px]`), letter-spacing
 * (`tracking-[0.18em]`), line-height (`leading-[...]`), and raw inline
 * `fontSize` style literals — in `ui/src/components/**` and
 * `ui/src/pages/**` (including their *.test.tsx companions) with
 * references to CSS custom-property tokens defined in `ui/src/index.css`.
 *
 * Unlike Batch 1's color codemod (which used a hand-audited site table to
 * avoid false-positiving on non-color hex-like strings such as issue
 * references), this batch's patterns are unambiguous: `text-[Npx]`,
 * `text-[N.Nrem]`, `tracking-[N em]`, and `leading-[...]` inside Tailwind
 * class strings, and `fontSize: "Npx"` / `fontSize: "N.Nrem"` inline-style
 * string literals, cannot mean anything other than a type-size/spacing
 * value. A blanket regex sweep is therefore safe and is used here, scoped
 * to `ui/src/components/**` and `ui/src/pages/**` only. Numeric or
 * computed `fontSize` forms (e.g. `fontSize: 12`, `fontSize: Math.round(...)`)
 * are functional (third-party config objects / runtime-computed values)
 * and are left untouched — see ALLOWLIST_NOTES below.
 *
 * Token naming (verbatim value, no normalizing):
 *   --fs-<N>        font-size, px values, e.g. --fs-11: 11px;
 *   --fs-0_<N>rem   font-size, rem values, e.g. --fs-0_7rem: 0.7rem;
 *   --ls-0_<N>      letter-spacing, em values, e.g. --ls-0_18: 0.18em;
 *   --lh-<N>        line-height (px or unitless — none found this batch)
 *
 * Tailwind v4 paren-shorthand rewrite forms used:
 *   text-[Npx]        -> text-(length:--fs-N)      (length hint REQUIRED —
 *                                                    bare text-(--x) means color)
 *   tracking-[N em]    -> tracking-(--ls-0_N)        (unambiguous, no hint)
 *   leading-[...]      -> leading-(--lh-N)            (unambiguous, no hint)
 * All variant/modifier prefixes (`sm:`, `dark:`, `group-hover:`,
 * `[&>x]:`, trailing `!important` marker, etc.) are preserved verbatim —
 * the regex only rewrites the bracket portion itself.
 *
 * Idempotent: the FIND regex only matches the ORIGINAL bracket-literal
 * form (`text-[11px]` etc.); once rewritten to `text-(length:--fs-11)` the
 * pattern no longer matches, so re-running is a no-op. The inline-style
 * FIND is likewise the literal `fontSize: "11px"` string form.
 *
 * Usage: node scripts/codemod-extract-type.mjs [--check]
 *   --check   Report what WOULD change without writing files (dry run).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_SRC = resolve(REPO_ROOT, "ui/src");
const SCAN_DIRS = ["components", "pages"];

const DRY_RUN = process.argv.includes("--check");

// ── Helpers ────────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
}

function tokenSuffixForPx(value) {
  // "11" -> "11", "0.65" -> "0_65"
  return value.replace(".", "_");
}

function tokenSuffixForEm(value) {
  // "0.18" -> "0_18"
  return value.replace(".", "_");
}

// ── Token registries (populated as sites are discovered) ───────────────
// Map of token name (without --) -> { value, comment, kind }
const fsTokens = new Map(); // font-size
const lsTokens = new Map(); // letter-spacing
const lhTokens = new Map(); // line-height

function registerFsToken(rawValue, unit, sourceNote) {
  const name = unit === "px" ? `fs-${tokenSuffixForPx(rawValue)}` : `fs-${tokenSuffixForPx(rawValue)}rem`;
  if (!fsTokens.has(name)) {
    fsTokens.set(name, { value: `${rawValue}${unit}`, comment: sourceNote });
  }
  return name;
}

function registerLsToken(rawValue, sourceNote) {
  const name = `ls-${tokenSuffixForEm(rawValue)}`;
  if (!lsTokens.has(name)) {
    lsTokens.set(name, { value: `${rawValue}em`, comment: sourceNote });
  }
  return name;
}

function registerLhToken(rawValue, sourceNote) {
  // rawValue includes unit already stripped by caller; store as given
  const safeName = rawValue.replace(/[^a-zA-Z0-9]/g, "_");
  const name = `lh-${safeName}`;
  if (!lhTokens.has(name)) {
    lhTokens.set(name, { value: rawValue, comment: sourceNote });
  }
  return name;
}

// ── Regexes ──────────────────────────────────────────────────────────
// text-[11px], text-[0.65rem], with optional /[Npx] line-height suffix
// (none found in this codebase, but handled for completeness/future-proofing).
const FS_RE = /text-\[([0-9.]+)(px|rem)\](?:\/\[([0-9.]+)(px|rem)\])?/g;
const LS_RE = /tracking-\[([0-9.]+)em\]/g;
const LEADING_RE = /leading-\[([^\]]+)\]/g;
const FONTSIZE_STYLE_RE = /fontSize:\s*"([0-9.]+)(px|rem)"/g;

function rewriteFile(filePath, relPath) {
  const original = readFileSync(filePath, "utf8");
  let content = original;
  let siteCount = 0;

  // -- font-size Tailwind class utilities --
  content = content.replace(FS_RE, (match, num, unit, lhNum, lhUnit) => {
    const fsName = registerFsToken(num, unit, `Extracted from ${relPath} (text-[${num}${unit}]).`);
    let replacement = `text-(length:--${fsName})`;
    if (lhNum) {
      const lhName = registerLhToken(`${lhNum}${lhUnit}`, `Extracted from ${relPath} (text-[...]/[${lhNum}${lhUnit}] line-height suffix).`);
      replacement += `/(--${lhName})`;
    }
    siteCount++;
    return replacement;
  });

  // -- letter-spacing Tailwind class utilities --
  content = content.replace(LS_RE, (match, num) => {
    const lsName = registerLsToken(num, `Extracted from ${relPath} (tracking-[${num}em]).`);
    siteCount++;
    return `tracking-(--${lsName})`;
  });

  // -- line-height Tailwind class utilities (standalone leading-[...]) --
  content = content.replace(LEADING_RE, (match, raw) => {
    // Only rewrite numeric/unit literals (px, rem, unitless number). Skip
    // keyword forms like leading-[inherit] or var()-based (already tokenized).
    if (!/^[0-9.]+(px|rem)?$/.test(raw)) return match;
    const lhName = registerLhToken(raw, `Extracted from ${relPath} (leading-[${raw}]).`);
    siteCount++;
    return `leading-(--${lhName})`;
  });

  // -- inline style fontSize string literals --
  content = content.replace(FONTSIZE_STYLE_RE, (match, num, unit) => {
    const fsName = registerFsToken(num, unit, `Extracted from ${relPath} (inline style fontSize: "${num}${unit}").`);
    siteCount++;
    return `fontSize: "var(--${fsName})"`;
  });

  if (content !== original && !DRY_RUN) {
    writeFileSync(filePath, content, "utf8");
  }
  return { changed: content !== original, siteCount };
}

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(resolve(UI_SRC, dir), files);

  let totalSites = 0;
  let filesChanged = 0;
  const changedFiles = [];

  for (const filePath of files) {
    const relPath = "ui/src/" + relative(UI_SRC, filePath);
    const { changed, siteCount } = rewriteFile(filePath, relPath);
    if (changed) {
      filesChanged++;
      changedFiles.push(relPath);
    }
    totalSites += siteCount;
  }

  // ── index.css token block ──────────────────────────────────────────
  const cssPath = resolve(UI_SRC, "index.css");
  const cssOriginal = readFileSync(cssPath, "utf8");
  const marker = "/* ── Extracted verbatim TYPE tokens (Phase 2 Batch 2, design/token-extraction) ── */";
  let cssNext = cssOriginal;
  let cssChanged = false;

  if (!cssOriginal.includes(marker) && (fsTokens.size || lsTokens.size || lhTokens.size)) {
    const lines = [];
    lines.push(marker);
    lines.push("/* Batch 2/4: font-size + letter-spacing + line-height literals, verbatim");
    lines.push("   (no normalizing — 9/10/11/12/13/14/15px and 0.08-0.24em all stay distinct;");
    lines.push("   the human scale-collapse decision comes later per DESIGN.md/TOKEN-AUDIT.md).");
    lines.push("");
    lines.push("   Allowlist (sites intentionally left as hardcoded / functional literals,");
    lines.push("   NOT converted to tokens — each also carries an inline");
    lines.push("   `token-extraction: allowlisted` comment at the site):");
    lines.push("   - pages/CompanyEnvironments.tsx (fontSize: 12) — xterm.js terminal theme");
    lines.push("     config; functional third-party numeric option, not a rendered CSS value.");
    lines.push("     Same allowlisted object as Batch 1's color entry for this file.");
    lines.push("   - pages/CompanySkills.tsx (fontSize: Math.round(size * 0.42)) — computed at");
    lines.push("     runtime from a prop; not a static literal, nothing to extract.");
    lines.push("*/");
    lines.push(":root {");
    for (const [name, { value, comment }] of fsTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of lsTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of lhTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    lines.push("}");
    const block = "\n" + lines.join("\n") + "\n";
    cssNext = cssOriginal + block;
    cssChanged = true;
  }

  if (cssChanged && !DRY_RUN) writeFileSync(cssPath, cssNext, "utf8");

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}codemod-extract-type summary`);
  console.log(`  Sites rewritten:        ${totalSites}`);
  console.log(`  Files changed:          ${filesChanged}`);
  console.log(`  New --fs-* tokens:      ${fsTokens.size}`);
  console.log(`  New --ls-* tokens:      ${lsTokens.size}`);
  console.log(`  New --lh-* tokens:      ${lhTokens.size}`);
  console.log(`  index.css token block:  ${cssChanged ? "added" : "already present or nothing to add (idempotent no-op)"}`);
  if (changedFiles.length) {
    console.log(`\n  Changed files:`);
    for (const f of changedFiles) console.log(`    - ${f}`);
  }
}

main();
