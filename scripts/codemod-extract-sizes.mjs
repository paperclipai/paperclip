#!/usr/bin/env node
/**
 * codemod-extract-sizes.mjs
 *
 * Phase 2 (extraction), Batch 3/4 of the design-token audit
 * (branch design/token-extraction). Replaces hardcoded SIZE / SPACING /
 * RADIUS / SHADOW arbitrary Tailwind bracket values in
 * `ui/src/components/**` and `ui/src/pages/**` (including their
 * *.test.tsx companions) with references to CSS custom-property tokens
 * defined in `ui/src/index.css`.
 *
 * Patterns covered (all unambiguous bracket-literal Tailwind utilities —
 * like Batch 2's font-size/tracking sweep, a blanket regex is safe here
 * because none of these utility prefixes have a non-dimensional meaning):
 *   w-[...] h-[...] size-[...] min-w-[...] max-w-[...] min-h-[...] max-h-[...]
 *   p-[...] pt/pb/pl/pr/px/py-[...] m-[...] mt/mb/ml/mr/mx/my-[...]
 *   gap-[...] gap-x-[...] gap-y-[...]
 *   inset-[...] inset-x/y-[...] top/left/right/bottom-[...]
 *   translate-x-[...] translate-y-[...]
 *   rounded-[...] and directional rounded-t/r/b/l/tl/tr/br/bl-[...]
 *   shadow-[...] ring-[...] outline-[...]
 * `!`-important-prefixed utilities (`!max-w-[90%]`) and variant/arbitrary-
 * variant prefixes (`sm:`, `dark:`, `[&>x]:`, etc.) are preserved verbatim —
 * the regex only rewrites the bracket portion itself.
 *
 * BOUNDARY GOTCHA (found + fixed during this batch's dry run): a naive
 * `\b(top|left|right|bottom)-\[...\]` regex false-positives on Tailwind's
 * OWN compound animation utilities `slide-out-to-top-[1%]` /
 * `slide-in-from-top-[1%]` (`components/ui/dialog.tsx`,
 * `components/ui/alert-dialog.tsx`) — `\b` matches at the `-to-top`
 * boundary because `-` is not a word character, so the regex would rewrite
 * only the `top-[1%]` tail of a longer utility name and silently corrupt
 * `slide-out-to-top-[1%]` into `slide-out-to-top-(--pct-1)` (which Tailwind
 * would not recognize as the `slide-out-to-top-*` animation-direction
 * utility at all — a real visual regression, not just a naming nit). Fixed
 * by requiring the utility name to start at a genuine class-token boundary
 * (preceded by whitespace, a quote character, backtick, template-literal
 * `${`, or the start of the string) rather than a bare `\b`.
 *
 * Token naming (verbatim value, no normalizing/rounding/unit-conversion):
 *   --sz-<value><unit>   width/height/spacing lengths — ONE shared family so
 *                        identical values dedupe across w/h/p/m/gap/inset/etc.
 *                        e.g. --sz-320: 320px;  --sz-0_7rem: 0.7rem;
 *                        --sz-85vh: 85vh;  --sz-24ch: 24ch;
 *   --sz-calc-<n>        calc(...)/min()/max()/clamp() forms, sequentially
 *                        numbered (values are not safely nameable by content
 *                        without ambiguity), each with an inline comment.
 *   --sz-safe-<edge>     bare env(safe-area-inset-<edge>) forms, verbatim.
 *   --pct-<N>            bare percentage values, e.g. --pct-50: 50%;
 *   --pct-neg-<N>        negative percentage values as they literally
 *                        appear in the bracket (e.g. translate-x-[-50%]),
 *                        e.g. --pct-neg-50: -50%; (kept as a DISTINCT token
 *                        from --pct-50 rather than negated at the utility
 *                        level, since the source bracket already carries the
 *                        minus sign inside the value, not as a utility
 *                        prefix — see Step 0 spike notes in TOKEN-AUDIT.md).
 *   --rad-<value>        radius/ring/outline width values (unitless numeric
 *                        suffix, unit implied px unless the source used a
 *                        different unit, in which case the unit is appended
 *                        to the name for disambiguation), e.g. --rad-8: 8px;
 *   --shadow-extract-<n> shadow values verbatim (multi-stop shadows are not
 *                        nameable by content), each with an inline comment.
 *                        Underscore-to-space reversal applied (Tailwind's
 *                        own bracket-escaping convention; see Batch 1's
 *                        gradient gotcha, generalized here to shadows).
 *
 * CALC-SPACING GOTCHA (Batch 1's underscore lesson, generalized): Tailwind's
 * bracket escaping uses `_` for literal spaces (`calc(-50%_-_2px)`), but
 * `calc(100%-2rem)` (WITHOUT underscores, i.e. no space around the operator
 * AT ALL in the original bracket) is *also* present in this codebase and is
 * INVALID CSS once lifted verbatim into a custom property — verified via a
 * headless-browser Step 0 spike: `calc(100%-2rem)` silently drops (falls
 * back to the containing block's width) while `calc(100% - 2rem)` (spaces
 * added) computes correctly. Every calc() lifted into a token by this
 * codemod therefore has spaces normalized around its top-level `+`/`-`
 * operators (percent/length arithmetic), in addition to underscore reversal.
 *
 * Tailwind v4 paren-shorthand rewrite forms used (confirmed via mandatory
 * Step-0 syntax spike — scratch story + `pnpm build-storybook` + grep of
 * emitted CSS, then deleted before this codemod ran):
 *   w-[320px]              -> w-(--sz-320)                 width:var(--sz-320)
 *   max-h-[85vh]           -> max-h-(--sz-85vh)             max-height:var(...)
 *   p-[18px]               -> p-(--sz-18)                   padding:var(...)
 *   gap-[3px]              -> gap-(--sz-3)                  gap:var(...)
 *   rounded-[8px]          -> rounded-(--rad-8)              border-radius
 *   rounded-br-[4px]       -> rounded-br-(--rad-4)           border-bottom-right-radius
 *   shadow-[...]           -> shadow-(--shadow-extract-N)     box-shadow (bare
 *                             form works — no `shadow:` hint needed; verified
 *                             identical emitted rule to the hinted form).
 *   top-[50%]              -> top-(--pct-50)                 top:var(...)
 *   translate-x-[-50%]     -> translate-x-(--pct-neg-50)      --tw-translate-x:var(...)
 *   pb-[env(safe-area-inset-bottom)] -> pb-(--sz-safe-bottom) padding-bottom
 *   w-[var(--radix-popover-trigger-width)] -> w-(--radix-popover-trigger-width)
 *     (brackets that only wrap a var() reference a runtime library variable
 *     directly — no new token minted, per DESIGN.md special-case guidance).
 *
 * ring-[Npx] / outline-[Npx] note: `ring`/`outline` are box-shadow/outline-
 * width utilities whose bracket form sets a WIDTH, not a generic length or
 * shadow value — and `ring`/`outline` ALSO have color-bracket forms
 * (`ring-[#hex]`). The correct paren-shorthand hint is `ring-(length:--x)` /
 * `outline-(length:--x)` (spiked and confirmed correct — a bare `ring-(--x)`
 * would be ambiguous the same way `text-(--x)` is). No ring/outline color-
 * bracket sites exist in this codebase (verified during Step 0 inventory),
 * so only the width form is handled.
 *
 * `calc(theme(spacing.N)±Mpx)` forms (components/IssueRow.tsx): theme() is a
 * Tailwind BUILD-TIME function and does not work inside a runtime CSS custom
 * property. This codemod resolves theme(spacing.N) using Tailwind v4's
 * default `--spacing: 0.25rem` base (confirmed via Step 0: no `--spacing`
 * override exists in index.css, and the ACTUAL BUILT CSS for these exact
 * classes was inspected before this codemod ran and shows
 * `padding-left:calc(.5rem - 2px)` / `calc(.25rem - 2px)` for
 * theme(spacing.2)/theme(spacing.1) respectively, and a plain
 * `margin-left:1.25rem` for the fully-constant
 * theme(spacing.3)+theme(spacing.2) expression, i.e. Tailwind pre-resolves
 * it when both operands are compile-time constants). The resolved-equivalent
 * calc() is minted as the token value (byte-equivalent computed output
 * verified via headless-browser spike, see TOKEN-AUDIT.md Batch 3 log).
 *
 * Idempotent: the FIND regex only matches the ORIGINAL bracket-literal form;
 * once rewritten the pattern no longer matches, so re-running is a no-op.
 *
 * Usage: node scripts/codemod-extract-sizes.mjs [--check]
 *   --check   Report what WOULD change without writing files (dry run).
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
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

// Tailwind bracket-escaping uses `_` for literal spaces; reverse it before
// writing into a real CSS custom property value. No site in this batch uses
// `\_` (escaped underscore meaning a LITERAL underscore) — verified by
// inspection of every match — so a plain global replace is safe.
function unescapeSpaces(value) {
  return value.replace(/_/g, " ");
}

// Ensures whitespace around top-level +/- operators inside calc()/min()/
// max()/clamp() so the expression is valid once it's the value of a runtime
// custom property (see CALC-SPACING GOTCHA in the header comment).
//
// DELIBERATELY NARROW: only rewrites a +/- whose LEFT side is a number,
// number+unit, or a closing paren `)`, and whose RIGHT side is a number or
// the start of a known CSS value-function call (`env(`, `var(`, `calc(`,
// `min(`, `max(`, `clamp(`). This excludes any hyphen that sits between two
// bare identifier characters — critical because a naive "any letter-hyphen-
// letter" rule corrupts `env(safe-area-inset-bottom)` into
// `env(safe - area - inset - bottom)` (caught during this batch's dry run;
// see CALC-SPACING GOTCHA). A leading unary minus right after `(`/`,`/start
// (e.g. `min(-40px, ...)`) is also left untouched since nothing precedes it
// on the left to match.
const CALC_UNIT = "(?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%)";
const CALC_NUM = "[0-9]*\\.?[0-9]+";
const CALC_FUNC = "(?:env|var|calc|min|max|clamp)\\(";
const CALC_SPACING_RE = new RegExp(
  `(${CALC_NUM}${CALC_UNIT}|${CALC_NUM}|\\))\\s*([+-])\\s*(?=${CALC_NUM}|${CALC_FUNC})`,
  "g",
);
function normalizeCalcSpacing(value) {
  return value.replace(CALC_SPACING_RE, (m, left, op) => `${left} ${op} `);
}

// "320" "0.7rem" "-50" etc -> safe token-name suffix. Dots become
// underscores (matches Batch 2's `--fs-0_7rem` convention); a leading minus
// is spelled out as `neg-` for readability.
function safeSuffix(value) {
  let v = value;
  const negative = v.startsWith("-");
  if (negative) v = v.slice(1);
  v = v.replace(/\./g, "_");
  return negative ? `neg-${v}` : v;
}

// ── Token registries ────────────────────────────────────────────────────
const szTokens = new Map(); // --sz-* (width/height/spacing/gap/inset lengths, shared family)
const radTokens = new Map(); // --rad-* (radius/ring-width/outline-width, shared family)
const pctTokens = new Map(); // --pct-* / --pct-neg-*
const shadowTokens = new Map(); // --shadow-extract-*
let calcCounter = 0;
let shadowCounter = 0;

function registerSzToken(rawValue, unit, sourceNote) {
  const value = `${rawValue}${unit}`;
  const name = `sz-${safeSuffix(rawValue)}${unit}`;
  if (!szTokens.has(name)) szTokens.set(name, { value, comment: sourceNote });
  return name;
}

// Percentages: --pct-50 for "50", --pct-neg-50 for "-50" (kept distinct per
// DESIGN.md Step-0 spike guidance — the minus sign is IN the bracket value).
function registerPctToken(rawNum, sourceNote) {
  const name = `pct-${safeSuffix(rawNum)}`;
  const value = `${rawNum}%`;
  if (!pctTokens.has(name)) pctTokens.set(name, { value, comment: sourceNote });
  return name;
}

// Radius / ring-width / outline-width family, shared. Unit is only appended
// to the name when it's not a bare px number (px is the overwhelming
// majority and matches Batch 1/2's bare-number convention, e.g. --fs-11).
function registerRadToken(rawValue, unit, sourceNote) {
  const value = `${rawValue}${unit}`;
  const name = unit === "px" ? `rad-${safeSuffix(rawValue)}` : `rad-${safeSuffix(rawValue)}${unit}`;
  if (!radTokens.has(name)) radTokens.set(name, { value, comment: sourceNote });
  return name;
}

// calc()/env()/min()/max()/clamp() forms and any other compound expression:
// minted 1:1 per distinct (already-unescaped, space-normalized) string into
// the --sz-* family, named sequentially (content isn't safely nameable) with
// a comment noting origin. Reused across sites if the exact string recurs.
const calcByValue = new Map(); // normalized value -> token name
function registerCalcToken(normalizedValue, sourceNote) {
  if (calcByValue.has(normalizedValue)) return calcByValue.get(normalizedValue);
  calcCounter += 1;
  const name = `sz-calc-${calcCounter}`;
  szTokens.set(name, { value: normalizedValue, comment: sourceNote });
  calcByValue.set(normalizedValue, name);
  return name;
}

function registerSafeAreaToken(edge, unescapedValue, sourceNote) {
  const name = `sz-safe-${edge}`;
  if (!szTokens.has(name)) szTokens.set(name, { value: unescapedValue, comment: sourceNote });
  return name;
}

const shadowByValue = new Map(); // unescaped shadow value -> token name
function registerShadowToken(unescapedValue, sourceNote) {
  if (shadowByValue.has(unescapedValue)) return shadowByValue.get(unescapedValue);
  shadowCounter += 1;
  const name = `shadow-extract-${shadowCounter}`;
  shadowTokens.set(name, { value: unescapedValue, comment: sourceNote });
  shadowByValue.set(unescapedValue, name);
  return name;
}

// ── Classification of a raw bracket value ───────────────────────────────
// Returns { tokenRef, isVarOnly } where tokenRef is the FULL replacement
// content to place inside `(...)`, e.g. "--sz-320" or
// "--radix-popover-trigger-width" (var-only passthrough, no new token).
const SIMPLE_LENGTH_RE = /^(-?[0-9.]+)(px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%)$/;
const VAR_ONLY_RE = /^var\((--[a-zA-Z0-9-]+)\)$/;
const ENV_ONLY_RE = /^env\((safe-area-inset-[a-z]+)\)$/;
const THEME_SPACING_RE = /theme\(spacing\.([0-9.]+)\)/g;

// Tailwind v4 default spacing scale: --spacing: 0.25rem (confirmed via Step 0:
// no --spacing override exists in ui/src/index.css).
const TAILWIND_SPACING_BASE_REM = 0.25;

function resolveThemeSpacing(raw) {
  // Resolves theme(spacing.N) tokens to their rem equivalents so the
  // expression can live inside a runtime CSS custom property (theme() is a
  // Tailwind build-time function and does not work at runtime).
  return raw.replace(THEME_SPACING_RE, (_m, n) => {
    const rem = Number(n) * TAILWIND_SPACING_BASE_REM;
    // Keep a leading zero (0.5rem, not .5rem) for readability; verified
    // byte-equivalent computed output vs Tailwind's own `.5rem` form.
    return `${rem}rem`;
  });
}

function classifyBracketValue(raw, { kind, sourceNote }) {
  // 1) Bare var() passthrough — no new token, per DESIGN.md special case.
  const varOnly = raw.match(VAR_ONLY_RE);
  if (varOnly) return { tokenRef: varOnly[1], isVarOnly: true };

  // 2) Bare env(safe-area-inset-*) passthrough — mint a --sz-safe-<edge> token.
  const envOnly = raw.match(ENV_ONLY_RE);
  if (envOnly) {
    const edge = envOnly[1].replace("safe-area-inset-", "");
    const name = registerSafeAreaToken(edge, `env(${envOnly[1]})`, sourceNote);
    return { tokenRef: `--${name}`, isVarOnly: false };
  }

  // 3) Simple numeric length / percentage.
  const simple = raw.match(SIMPLE_LENGTH_RE);
  if (simple) {
    const [, num, unit] = simple;
    if (unit === "%") {
      const name = registerPctToken(num, sourceNote);
      return { tokenRef: `--${name}`, isVarOnly: false };
    }
    if (kind === "radius") {
      const name = registerRadToken(num, unit, sourceNote);
      return { tokenRef: `--${name}`, isVarOnly: false };
    }
    const name = registerSzToken(num, unit, sourceNote);
    return { tokenRef: `--${name}`, isVarOnly: false };
  }

  // 4) Everything else: calc()/min()/max()/clamp()/env()-mixed compound
  // expressions. Reverse Tailwind's underscore-space escaping, normalize
  // calc operator spacing, resolve any theme(spacing.N) build-time calls,
  // and mint a sequential --sz-calc-N.
  let normalized = unescapeSpaces(raw);
  normalized = resolveThemeSpacing(normalized);
  normalized = normalizeCalcSpacing(normalized);
  const name = registerCalcToken(normalized, sourceNote);
  return { tokenRef: `--${name}`, isVarOnly: false };
}

// ── Regexes for each utility family ──────────────────────────────────────
// Every regex requires the utility to start at a genuine class-token
// boundary — preceded by whitespace, a quote/backtick, template-literal
// `${`, or the start of the string — NOT a bare `\b`, which would
// false-positive inside compound utility names like
// `slide-out-to-top-[1%]` (see BOUNDARY GOTCHA in the header comment).
// Each captures: (1) optional `!important` prefix, (2) the utility name
// (with any directional/axis suffix), (3) the raw bracket contents.
// `:` is included because Tailwind variant prefixes (`sm:`, `dark:`,
// `focus-visible:`, `data-[state=open]:`, etc.) always precede the utility
// name with a colon — a safe class-token boundary, never part of a longer
// utility's own name.
const BOUNDARY = String.raw`(?<=^|[\s"'\`{:])`;

const UTILITIES = [
  // width/height/size family
  { re: new RegExp(`${BOUNDARY}(!?)(w|h|size|min-w|max-w|min-h|max-h)-\\[([^\\]]+)\\]`, "g"), kind: "length" },
  // padding/margin family
  { re: new RegExp(`${BOUNDARY}(!?)(p|pt|pb|pl|pr|px|py|m|mt|mb|ml|mr|mx|my)-\\[([^\\]]+)\\]`, "g"), kind: "length" },
  // gap family
  { re: new RegExp(`${BOUNDARY}(!?)(gap|gap-x|gap-y)-\\[([^\\]]+)\\]`, "g"), kind: "length" },
  // inset / top / left / right / bottom family
  { re: new RegExp(`${BOUNDARY}(!?)(inset-x|inset-y|inset|top|left|right|bottom)-\\[([^\\]]+)\\]`, "g"), kind: "length" },
  // translate family
  { re: new RegExp(`${BOUNDARY}(!?)(translate-x|translate-y)-\\[([^\\]]+)\\]`, "g"), kind: "length" },
];

// Radius: bare `rounded-[...]` and directional `rounded-t/r/b/l/tl/tr/bl/br-[...]`.
// `rounded-[inherit]` is a KEYWORD (not a numeric literal) — per the batch
// mandate, skip it (documented in the extraction log / allowlist below).
const ROUNDED_RE = new RegExp(`${BOUNDARY}(!?)rounded(-(?:tl|tr|bl|br|t|r|b|l))?-\\[([^\\]]+)\\]`, "g");

// Shadow: bare `shadow-[...]`.
const SHADOW_RE = new RegExp(`${BOUNDARY}(!?)shadow-\\[([^\\]]+)\\]`, "g");

// Ring width: bare `ring-[Npx]` (color-bracket forms like `ring-[#hex]` are
// NOT touched here — this batch is size/spacing/radius/shadow only, and no
// ring color-bracket sites exist in this codebase; verified during Step 0
// inventory). Requires the `length:` hint per the Step-0 spike (see header).
const RING_RE = new RegExp(`${BOUNDARY}(!?)ring-\\[([^\\]]+)\\]`, "g");

// Outline width (numeric only; no outline-[...] sites exist in this
// codebase per Step 0 inventory, kept for forward-compatibility/completeness).
const OUTLINE_RE = new RegExp(`${BOUNDARY}(!?)outline-\\[([^\\]]+)\\]`, "g");

function rewriteFile(filePath, relPath) {
  const original = readFileSync(filePath, "utf8");
  let content = original;
  let siteCount = 0;

  for (const { re, kind } of UTILITIES) {
    content = content.replace(re, (match, bang, util, raw) => {
      const sourceNote = `Extracted from ${relPath} (${util}-[${raw}]).`;
      const { tokenRef } = classifyBracketValue(raw, { kind, sourceNote });
      siteCount++;
      return `${bang}${util}-(${tokenRef})`;
    });
  }

  // Radius (needs its own hint-free paren form + inherit skip).
  content = content.replace(ROUNDED_RE, (match, bang, dir, raw) => {
    if (raw === "inherit") return match; // keyword, not a literal — skip (see log)
    const util = `rounded${dir || ""}`;
    const sourceNote = `Extracted from ${relPath} (${util}-[${raw}]).`;
    const { tokenRef } = classifyBracketValue(raw, { kind: "radius", sourceNote });
    siteCount++;
    return `${bang}${util}-(${tokenRef})`;
  });

  // Shadow (always unescape underscores + normalize calc spacing inside any
  // embedded rgba()/hsl() var() args; bare paren form confirmed correct via
  // Step 0 spike — no `shadow:` hint needed).
  content = content.replace(SHADOW_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (shadow-[${raw}]).`;
    const name = registerShadowToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}shadow-(--${name})`;
  });

  // Ring width (length hint required — bare ring-(--x) is ambiguous with
  // the color-bracket form per the Step-0 spike).
  content = content.replace(RING_RE, (match, bang, raw) => {
    const sourceNote = `Extracted from ${relPath} (ring-[${raw}]).`;
    const { tokenRef, isVarOnly } = classifyBracketValue(raw, { kind: "radius", sourceNote });
    siteCount++;
    const hint = isVarOnly ? "" : "length:";
    return `${bang}ring-(${hint}${tokenRef})`;
  });

  // Outline width (same length-hint treatment; 0 sites exist today).
  content = content.replace(OUTLINE_RE, (match, bang, raw) => {
    const sourceNote = `Extracted from ${relPath} (outline-[${raw}]).`;
    const { tokenRef, isVarOnly } = classifyBracketValue(raw, { kind: "radius", sourceNote });
    siteCount++;
    const hint = isVarOnly ? "" : "length:";
    return `${bang}outline-(${hint}${tokenRef})`;
  });

  if (content !== original && !DRY_RUN) {
    writeFileSync(filePath, content, "utf8");
  }
  return { changed: content !== original, siteCount };
}

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(resolve(UI_SRC, dir), files);
  files.sort();

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
  const marker = "/* ── Extracted verbatim SIZE/SPACING/RADIUS/SHADOW tokens (Phase 2 Batch 3, design/token-extraction) ── */";
  let cssNext = cssOriginal;
  let cssChanged = false;

  const anyTokens = szTokens.size || radTokens.size || pctTokens.size || shadowTokens.size;
  if (!cssOriginal.includes(marker) && anyTokens) {
    const lines = [];
    lines.push(marker);
    lines.push("/* Batch 3/4: width/height/min/max, padding/margin/gap/inset/translate,");
    lines.push("   radius, ring/outline-width, and shadow literals, verbatim (no");
    lines.push("   normalizing — the human scale-collapse decision comes later per");
    lines.push("   DESIGN.md/TOKEN-AUDIT.md). --sz-* is ONE shared family across");
    lines.push("   w/h/p/m/gap/inset/translate so identical values dedupe regardless of");
    lines.push("   which property used them. --rad-* is likewise shared across");
    // NOTE: never write a literal "*/" sequence in this prose (e.g. from a
    // "rounded-*" + "/ring" join) — it prematurely closes this CSS block
    // comment and silently corrupts everything after it (caught during this
    // batch's verification: the entire --sz-*/--rad-*/--pct-*/--shadow-*
    // :root block was being dropped from the built CSS because of exactly
    // this). Always phrase such utility-family lists with "and" instead of
    // a bare slash-adjacent asterisk.
    lines.push("   rounded, ring, and outline widths.");
    lines.push("");
    lines.push("   Allowlist (sites intentionally left as hardcoded / functional literals");
    lines.push("   or var()-only passthrough with no new token minted):");
    lines.push("   - components/ui/scroll-area.tsx (rounded-[inherit]) — CSS keyword, not a");
    lines.push("     literal value; nothing to extract.");
    lines.push("   - Bracket values that only wrap var(--radix-*-trigger-width/height) or");
    lines.push("     var(--new-issue-dialog-height) etc. are rewritten to the bare paren");
    lines.push("     form directly (e.g. w-(--radix-popover-trigger-width)) — these are");
    lines.push("     runtime library/component variables, not design values, so no new");
    lines.push("     --sz-* token is minted for them (see TOKEN-AUDIT.md extraction log");
    lines.push("     for the full site list).");
    lines.push("*/");
    lines.push(":root {");
    for (const [name, { value, comment }] of szTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of radTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of pctTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of shadowTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    lines.push("}");
    const block = "\n" + lines.join("\n") + "\n";
    cssNext = cssOriginal + block;
    cssChanged = true;
  }

  if (cssChanged && !DRY_RUN) writeFileSync(cssPath, cssNext, "utf8");

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}codemod-extract-sizes summary`);
  console.log(`  Sites rewritten:        ${totalSites}`);
  console.log(`  Files changed:          ${filesChanged}`);
  console.log(`  New --sz-* tokens:      ${szTokens.size}`);
  console.log(`  New --rad-* tokens:     ${radTokens.size}`);
  console.log(`  New --pct-* tokens:     ${pctTokens.size}`);
  console.log(`  New --shadow-extract-*: ${shadowTokens.size}`);
  console.log(`  index.css token block:  ${cssChanged ? "added" : "already present or nothing to add (idempotent no-op)"}`);
  if (changedFiles.length) {
    console.log(`\n  Changed files:`);
    for (const f of changedFiles) console.log(`    - ${f}`);
  }
}

main();
