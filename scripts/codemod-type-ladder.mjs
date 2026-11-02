#!/usr/bin/env node
/**
 * codemod-type-ladder.mjs
 *
 * DECISION-SHEET.md B3 (user-locked, preset-tune session): collapse the
 * Batch 2 verbatim type tokens into the named ladder.
 *
 * FONT SIZES (8 --fs-* tokens -> 3 named tokens + 2 Tailwind scale classes):
 *   --fs-9, --fs-10          -> --text-nano: 10px   (9 -> 10 bump)
 *   --fs-11, --fs-0_7rem     -> --text-micro: 11px  (0.7rem = 11.2px -> 11px)
 *   --fs-12                  -> Tailwind `text-xs`  (12px exact match;
 *                               scale class preferred over token per DESIGN.md)
 *   --fs-13                  -> --text-compact: 13px
 *   --fs-14, --fs-15         -> Tailwind `text-sm`  (14px; 15 -> 14)
 *
 * LETTER-SPACING (9 --ls-* tokens -> 3 named steps, nearest-step mapping):
 *   0.08em, 0.1em                  -> --tracking-label: 0.08em
 *   0.12em, 0.14em, 0.16em         -> --tracking-eyebrow: 0.14em
 *   0.18em, 0.2em, 0.22em, 0.24em  -> --tracking-caps: 0.2em
 *
 * The codemod rewrites every site under ui/src (components, pages, lib,
 * context, plugins — all .ts/.tsx/.js/.jsx), replaces the --fs-* / --ls-*
 * definitions in ui/src/index.css with the named-ladder block, and fails
 * loudly if any --fs-* / --ls-* reference survives (e.g. a var(--fs-12) site,
 * which has no token replacement because that bucket maps to a Tailwind
 * scale class and would need a manual decision).
 *
 * Replacements are exact strings INCLUDING the closing paren, so prefix
 * collisions (--ls-0_1 vs --ls-0_12, --fs-1* families) cannot mis-match.
 *
 * IDEMPOTENT: a second run finds no old references and the ladder marker
 * already present in index.css, and changes nothing.
 *
 * Usage: node scripts/codemod-type-ladder.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_SRC = resolve(REPO_ROOT, "ui/src");
const CSS_PATH = resolve(UI_SRC, "index.css");

// ── Site replacement map (exact strings, closing paren included) ─────────
const SITE_MAP = new Map([
  // font sizes — Tailwind utility form (Batch 2 syntax)
  ["text-(length:--fs-9)", "text-(length:--text-nano)"],
  ["text-(length:--fs-10)", "text-(length:--text-nano)"],
  ["text-(length:--fs-11)", "text-(length:--text-micro)"],
  ["text-(length:--fs-0_7rem)", "text-(length:--text-micro)"],
  ["text-(length:--fs-12)", "text-xs"],
  ["text-(length:--fs-13)", "text-(length:--text-compact)"],
  ["text-(length:--fs-14)", "text-sm"],
  ["text-(length:--fs-15)", "text-sm"],
  // font sizes — inline-style var() form
  ["var(--fs-9)", "var(--text-nano)"],
  ["var(--fs-10)", "var(--text-nano)"],
  ["var(--fs-11)", "var(--text-micro)"],
  ["var(--fs-0_7rem)", "var(--text-micro)"],
  ["var(--fs-13)", "var(--text-compact)"],
  // (var(--fs-12/14/15) intentionally absent: those buckets map to Tailwind
  //  scale classes; any such site trips the leftover guard for manual review)
  // letter-spacing — Tailwind utility form
  ["tracking-(--ls-0_08)", "tracking-(--tracking-label)"],
  ["tracking-(--ls-0_1)", "tracking-(--tracking-label)"],
  ["tracking-(--ls-0_12)", "tracking-(--tracking-eyebrow)"],
  ["tracking-(--ls-0_14)", "tracking-(--tracking-eyebrow)"],
  ["tracking-(--ls-0_16)", "tracking-(--tracking-eyebrow)"],
  ["tracking-(--ls-0_18)", "tracking-(--tracking-caps)"],
  ["tracking-(--ls-0_2)", "tracking-(--tracking-caps)"],
  ["tracking-(--ls-0_22)", "tracking-(--tracking-caps)"],
  ["tracking-(--ls-0_24)", "tracking-(--tracking-caps)"],
  // letter-spacing — inline-style var() form
  ["var(--ls-0_08)", "var(--tracking-label)"],
  ["var(--ls-0_1)", "var(--tracking-label)"],
  ["var(--ls-0_12)", "var(--tracking-eyebrow)"],
  ["var(--ls-0_14)", "var(--tracking-eyebrow)"],
  ["var(--ls-0_16)", "var(--tracking-eyebrow)"],
  ["var(--ls-0_18)", "var(--tracking-caps)"],
  ["var(--ls-0_2)", "var(--tracking-caps)"],
  ["var(--ls-0_22)", "var(--tracking-caps)"],
  ["var(--ls-0_24)", "var(--tracking-caps)"],
]);

const LADDER_MARKER = "Named type ladder (DECISION-SHEET.md B3";
const LADDER_BLOCK = `  /* ── Named type ladder (DECISION-SHEET.md B3, preset-tune session) ──
     Collapses the 8 verbatim --fs-* font-size tokens and 9 --ls-*
     letter-spacing tokens (extracted in Batch 2 above) into named steps.
     Codemod: scripts/codemod-type-ladder.mjs. Mapping:
       9px + 10px    -> --text-nano   (9 -> 10 bump per locked ladder)
       11px + 0.7rem -> --text-micro  (0.7rem = 11.2px -> 11px)
       12px          -> Tailwind \`text-xs\` class (12px exact match; scale
                        class preferred over a redundant token per DESIGN.md)
       13px          -> --text-compact (PRIOR-ART named this tier "sm 13",
                        but that collides with Tailwind text-sm = 14px,
                        hence "compact")
       14px + 15px   -> Tailwind \`text-sm\` class (14px; 15 -> 14)
     Letter-spacing, nearest-step mapping:
       0.08em, 0.1em                 -> --tracking-label
       0.12em, 0.14em, 0.16em        -> --tracking-eyebrow
       0.18em, 0.2em, 0.22em, 0.24em -> --tracking-caps
     NOTE: sites moved to text-xs/text-sm also pick up the Tailwind scale
     line-height (text-(length:--x) set font-size only) — intentional,
     reviewed on the post-preset contact sheet. */
  --text-nano: 10px;
  --text-micro: 11px;
  --text-compact: 13px;
  --tracking-label: 0.08em;
  --tracking-eyebrow: 0.14em;
  --tracking-caps: 0.2em;`;

// ── Walk ui/src ───────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
}

const files = [];
walk(UI_SRC, files);
files.sort();

// ── Pass 1: rewrite sites ─────────────────────────────────────────────────
const bucketCounts = new Map();
let filesTouched = 0;
for (const f of files) {
  const before = readFileSync(f, "utf8");
  let after = before;
  for (const [oldStr, newStr] of SITE_MAP) {
    if (!after.includes(oldStr)) continue;
    const n = after.split(oldStr).length - 1;
    after = after.split(oldStr).join(newStr);
    bucketCounts.set(oldStr, (bucketCounts.get(oldStr) ?? 0) + n);
  }
  if (after !== before) {
    writeFileSync(f, after);
    filesTouched++;
  }
}

// ── Pass 2: index.css — swap definitions for the ladder block ────────────
let css = readFileSync(CSS_PATH, "utf8");
if (!css.includes(LADDER_MARKER)) {
  const lines = css.split("\n");
  const DEF_RE = /^\s*--(?:fs-[0-9a-z_]+|ls-[0-9_]+):/;
  const firstDef = lines.findIndex((l) => DEF_RE.test(l));
  if (firstDef === -1) {
    console.error("ERROR: no --fs-* / --ls-* definitions found and ladder marker absent — index.css in unexpected state.");
    process.exit(1);
  }
  const kept = lines.filter((l) => !DEF_RE.test(l));
  // Insert the ladder block at the position of the first removed definition:
  // count how many kept lines precede the first definition line.
  let precede = 0;
  for (let i = 0; i < firstDef; i++) if (!DEF_RE.test(lines[i])) precede++;
  kept.splice(precede, 0, LADDER_BLOCK);
  css = kept.join("\n");
  writeFileSync(CSS_PATH, css);
  console.log("index.css: --fs-* / --ls-* definitions replaced with named ladder block");
} else {
  console.log("index.css: ladder marker already present — skipped (idempotent)");
}

// ── Guard: no survivors anywhere in ui/src (incl. index.css) ─────────────
const SURVIVOR_RE = /--(?:fs-[0-9a-z_]+|ls-[0-9_]+)/;
const survivors = [];
for (const f of [...files, CSS_PATH]) {
  const content = readFileSync(f, "utf8");
  const lines = content.split("\n");
  lines.forEach((l, i) => {
    if (SURVIVOR_RE.test(l)) survivors.push(`${relative(REPO_ROOT, f)}:${i + 1}: ${l.trim()}`);
  });
}

// ── Report ────────────────────────────────────────────────────────────────
const bucketTotals = {};
for (const [oldStr, n] of bucketCounts) {
  const target = SITE_MAP.get(oldStr);
  bucketTotals[target] = (bucketTotals[target] ?? 0) + n;
}
console.log("Sites rewritten per source form:");
for (const [oldStr, n] of [...bucketCounts.entries()].sort()) {
  console.log(`  ${oldStr}  ->  ${SITE_MAP.get(oldStr)}   (${n})`);
}
console.log("Totals per target bucket:", JSON.stringify(bucketTotals, null, 2));
console.log(`Files touched: ${filesTouched}`);

if (survivors.length > 0) {
  console.error(`\nERROR: ${survivors.length} leftover --fs-* / --ls-* reference(s) need manual review:`);
  for (const s of survivors) console.error("  " + s);
  process.exit(1);
}
console.log("No leftover --fs-* / --ls-* references. Done.");
