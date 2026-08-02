#!/usr/bin/env node
/**
 * codemod-extract-misc.mjs
 *
 * Phase 2 (extraction), Batch 4/4 (final sweep) of the design-token audit
 * (branch design/token-extraction). Replaces the remaining value-bearing
 * arbitrary Tailwind bracket utilities in `ui/src/components/**` and
 * `ui/src/pages/**` (including their *.test.tsx companions) with references
 * to CSS custom-property tokens defined in `ui/src/index.css`.
 *
 * Patterns covered this batch:
 *   grid-cols-[...] / grid-rows-[...]   -> --gtc-<n> / --gtr-<n> (track lists,
 *                                          deduped on exact string match)
 *   transition-[...]                    -> --tp-<slug> (property lists,
 *                                          deduped on exact string match)
 *   z-[...]                             -> --z-<n> (bare z-index scale values)
 *   scale-[...]                         -> --s-<slug>
 *   ease-[cubic-bezier(...)]            -> --e-<slug>
 *   align-[...]                         -> --va-<slug> (vertical-align)
 *   stroke-[...]                        -> --sw-<slug> (SVG stroke-WIDTH,
 *                                          requires the `length:` hint)
 *   blur-[...]                          -> --blur-<slug>
 *   drop-shadow-[...]                   -> --drop-shadow-extract-<n> (its own
 *                                          family, separate from Batch 3's
 *                                          --shadow-extract-* box-shadow
 *                                          family — filter vs. box-shadow are
 *                                          different CSS properties, see
 *                                          TOKEN-AUDIT.md Batch 3 "Needs human
 *                                          decision")
 *   bg-[linear|radial|conic-gradient(...)] -> --gradient-extract-<n>,
 *                                          CONTINUING Batch 1's counter (not
 *                                          restarting it) - 2 sites that use
 *                                          hsl(var(...))/color-mix(...)
 *                                          CSS-native color functions rather
 *                                          than raw hex/rgb literals, so
 *                                          Batch 1's hand-audited color table
 *                                          did not catch them even though
 *                                          they are the same gradient-bracket
 *                                          shape.
 *   bg|text|border-[var(--x)]           -> bare paren passthrough, no new
 *     (no fallback)                        token minted (same rule as Batch
 *                                          3's var()-only case)
 *   bg|text|border-[var(--x,fallback)]  -> mints a --*-resolved wrapper token
 *     (fallback form)                     whose value is `var(--x, fallback)`
 *                                          verbatim (paren-with-fallback-comma
 *                                          does not parse in Tailwind v4 —
 *                                          confirmed in the Step 0 spike --
 *                                          so the fallback expression itself
 *                                          must live in the CSS token, not in
 *                                          the utility). theme(colors.a.b)
 *                                          fallbacks are resolved to their
 *                                          BUILT-CSS equivalent var(...) form
 *                                          first (inspected from
 *                                          storybook-static output before
 *                                          writing this codemod - theme() is
 *                                          a Tailwind build-time function).
 *
 * NOT rewritten (documented, not a bug):
 *   - Selector/variant brackets (data-[...], group-data-[...], has-[...],
 *     aria-[...], supports-[...], etc.) are CSS selector conditions, not
 *     visual values - out of scope for this codemod BY DEFINITION (see
 *     check-token-gates.mjs header for the same distinction, gate 2).
 *   - tw-animate/animate-plugin arbitrary utilities (zoom-in-[0.97],
 *     zoom-out-[0.97], slide-in-from-top-[1%], slide-out-to-top-[1%]) plus
 *     their siblings (animate-in, animate-out, fade-in-0, fade-out-0):
 *     confirmed via the Step 0 spike that NONE of these compile to any CSS
 *     at all in this repo's build (no tw-animate-css plugin is installed,
 *     and no @utility overrides exist in index.css) - grep of the built
 *     storybook-static CSS shows zero occurrences of "animate-in", "zoom",
 *     "slide-in-from-top", etc. These are dead, no-op class names with zero
 *     rendered visual value today, so there is nothing to tokenize; touching
 *     them would not preserve OR change any pixel. Left untouched and
 *     allowlisted (third-party plugin syntax, retained for whenever
 *     tw-animate-css is actually installed) rather than silently deleted,
 *     since deleting dead classes is itself a (no-op but non-mechanical)
 *     edit outside this batch's mandate.
 *   - max-[480px] / min-[420px] breakpoint variants and rounded-[inherit]:
 *     documented allowlist entries, not code the codemod touches (variant
 *     position cannot reference a CSS custom property; `inherit` is a
 *     keyword). See ALLOWLIST block in index.css.
 *
 * Idempotent: the FIND regexes only match the ORIGINAL bracket-literal form;
 * once rewritten the pattern no longer matches, so re-running is a no-op.
 *
 * Usage: node scripts/codemod-extract-misc.mjs [--check]
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
// writing into a real CSS custom property value (Batch 1's gradient gotcha,
// generalized in Batch 3, applies again here for grid track lists / calc
// expressions embedded in transition/ease values).
function unescapeSpaces(value) {
  return value.replace(/_/g, " ");
}

// "320" "0.7rem" "-50" "auto_minmax(0,1fr)" etc -> safe token-name suffix.
// Dots become underscores, spaces/commas/parens/percent become hyphens,
// collapsed and trimmed (matches Batch 1-3's `--fs-0_7rem`-style convention
// for numeric suffixes; grid/transition/ease values use a slug instead since
// their content isn't a single number).
function slugify(value) {
  return value
    .trim()
    .replace(/_/g, " ")
    .replace(/\./g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

// ── Token registries ────────────────────────────────────────────────────
const gtcTokens = new Map(); // --gtc-<n> grid-template-columns
const gtrTokens = new Map(); // --gtr-<n> grid-template-rows
const tpTokens = new Map(); // --tp-<slug> transition-property lists
const zTokens = new Map(); // --z-<n>
const sTokens = new Map(); // --s-<slug> scale
const eTokens = new Map(); // --e-<slug> ease / timing-function
const vaTokens = new Map(); // --va-<slug> vertical-align
const swTokens = new Map(); // --sw-<slug> stroke-width
const blurTokens = new Map(); // --blur-<slug>
const dropShadowTokens = new Map(); // --drop-shadow-extract-<n>
const resolvedVarTokens = new Map(); // --*-resolved wrapper tokens (fallback var() forms)
// --gradient-extract-<n> continuing Batch 1's family/counter (these 2 sites
// use hsl(var(...))/color-mix(...) CSS-native color functions rather than
// raw hex/rgb literals, which is why Batch 1's hand-audited color-literal
// table did not catch them - they're still a value-bearing gradient bracket,
// in scope for this batch's "remaining bracket utilities" sweep).
const gradientTokens = new Map();

let gtcCounter = 0;
let gtrCounter = 0;
let dropShadowCounter = 0;
// Batch 1 minted --gradient-extract-1 through --gradient-extract-24; this
// batch's new gradient sites continue that numbering, not restart it.
let gradientCounter = 24;

const gtcByValue = new Map();
function registerGtcToken(unescapedValue, sourceNote) {
  if (gtcByValue.has(unescapedValue)) return gtcByValue.get(unescapedValue);
  gtcCounter += 1;
  const name = `gtc-${gtcCounter}`;
  gtcTokens.set(name, { value: unescapedValue, comment: sourceNote });
  gtcByValue.set(unescapedValue, name);
  return name;
}

const gtrByValue = new Map();
function registerGtrToken(unescapedValue, sourceNote) {
  if (gtrByValue.has(unescapedValue)) return gtrByValue.get(unescapedValue);
  gtrCounter += 1;
  const name = `gtr-${gtrCounter}`;
  gtrTokens.set(name, { value: unescapedValue, comment: sourceNote });
  gtrByValue.set(unescapedValue, name);
  return name;
}

function registerTpToken(unescapedValue, sourceNote) {
  const slug = slugify(unescapedValue.replace(/,/g, " "));
  const name = `tp-${slug}`;
  if (!tpTokens.has(name)) tpTokens.set(name, { value: unescapedValue, comment: sourceNote });
  return name;
}

function registerZToken(rawNum, sourceNote) {
  const name = `z-${rawNum}`;
  if (!zTokens.has(name)) zTokens.set(name, { value: rawNum, comment: sourceNote });
  return name;
}

function registerSToken(unescapedValue, sourceNote) {
  const slug = slugify(unescapedValue);
  const name = `s-${slug}`;
  if (!sTokens.has(name)) sTokens.set(name, { value: unescapedValue, comment: sourceNote });
  return name;
}

function registerEToken(unescapedValue, sourceNote) {
  const slug = slugify(unescapedValue);
  const name = `e-${slug}`;
  if (!eTokens.has(name)) eTokens.set(name, { value: unescapedValue, comment: sourceNote });
  return name;
}

function registerVaToken(unescapedValue, sourceNote) {
  const slug = slugify(unescapedValue);
  const name = `va-${slug}`;
  if (!vaTokens.has(name)) vaTokens.set(name, { value: unescapedValue, comment: sourceNote });
  return name;
}

function registerSwToken(unescapedValue, sourceNote) {
  const slug = slugify(unescapedValue);
  const name = `sw-${slug}`;
  if (!swTokens.has(name)) swTokens.set(name, { value: unescapedValue, comment: sourceNote });
  return name;
}

function registerBlurToken(unescapedValue, sourceNote) {
  const slug = slugify(unescapedValue);
  const name = `blur-${slug}`;
  if (!blurTokens.has(name)) blurTokens.set(name, { value: unescapedValue, comment: sourceNote });
  return name;
}

const gradientByValue = new Map();
function registerGradientToken(unescapedValue, sourceNote) {
  if (gradientByValue.has(unescapedValue)) return gradientByValue.get(unescapedValue);
  gradientCounter += 1;
  const name = `gradient-extract-${gradientCounter}`;
  gradientTokens.set(name, { value: unescapedValue, comment: sourceNote });
  gradientByValue.set(unescapedValue, name);
  return name;
}

const dropShadowByValue = new Map();
function registerDropShadowToken(unescapedValue, sourceNote) {
  if (dropShadowByValue.has(unescapedValue)) return dropShadowByValue.get(unescapedValue);
  dropShadowCounter += 1;
  const name = `drop-shadow-extract-${dropShadowCounter}`;
  dropShadowTokens.set(name, { value: unescapedValue, comment: sourceNote });
  dropShadowByValue.set(unescapedValue, name);
  return name;
}

// Wrapper tokens for the var(--x, fallback) forms that can't use the
// paren-with-fallback-comma shorthand (confirmed unsupported in the Step 0
// spike). theme(colors.a.b) fallbacks are resolved to the equivalent
// var(--token) form the Tailwind build already resolves them to today
// (inspected in ui/storybook-static/assets/*.css before writing this
// codemod - theme() is a Tailwind build-time function and cannot appear
// inside a runtime custom property).
const THEME_COLOR_MAP = {
  "theme(colors.muted.DEFAULT)": "var(--muted)",
  "theme(colors.muted.foreground)": "var(--muted-foreground)",
};

function resolveThemeColor(raw) {
  let out = raw;
  for (const [from, to] of Object.entries(THEME_COLOR_MAP)) {
    out = out.split(from).join(to);
  }
  return out;
}

function registerResolvedVarToken(varName, fallbackRaw, sourceNote) {
  // varName like "--paperclip-code-highlight-bg" -> token name
  // "code-highlight-bg-resolved" (strip the leading "--paperclip-" prefix
  // for readability, matching the mission's suggested name for the first
  // site; other vars in the same family follow the same convention).
  const bare = varName.replace(/^--paperclip-/, "").replace(/^--/, "");
  const name = `${bare}-resolved`;
  const fallback = resolveThemeColor(fallbackRaw);
  const value = `var(${varName}, ${fallback})`;
  if (!resolvedVarTokens.has(name)) resolvedVarTokens.set(name, { value, comment: sourceNote });
  return name;
}

// ── Regexes ──────────────────────────────────────────────────────────────
// Every regex requires the utility to start at a genuine class-token
// boundary (preceded by whitespace, a quote/backtick, template-literal `${`,
// or start-of-string) - see Batch 3's BOUNDARY GOTCHA. `:` is included for
// variant prefixes (`data-[state=open]:`, `sm:`, etc.).
const BOUNDARY = String.raw`(?<=^|[\s"'\`{:])`;

const GRID_COLS_RE = new RegExp(`${BOUNDARY}(!?)grid-cols-\\[([^\\]]+)\\]`, "g");
const GRID_ROWS_RE = new RegExp(`${BOUNDARY}(!?)grid-rows-\\[([^\\]]+)\\]`, "g");
const TRANSITION_RE = new RegExp(`${BOUNDARY}(!?)transition-\\[([^\\]]+)\\]`, "g");
const Z_RE = new RegExp(`${BOUNDARY}(!?)z-\\[([0-9]+)\\]`, "g");
const SCALE_RE = new RegExp(`${BOUNDARY}(!?)scale-\\[([^\\]]+)\\]`, "g");
const EASE_RE = new RegExp(`${BOUNDARY}(!?)ease-\\[([^\\]]+)\\]`, "g");
const ALIGN_RE = new RegExp(`${BOUNDARY}(!?)align-\\[([^\\]]+)\\]`, "g");
const STROKE_RE = new RegExp(`${BOUNDARY}(!?)stroke-\\[([^\\]]+)\\]`, "g");
// NOTE: negative lookbehind isn't reliably portable across regex engines at
// the boundary position used elsewhere, so drop-shadow is matched with its
// own explicit prefix (drop-shadow-) which never collides with bare blur-.
// Matches both bare `blur-[...]` and `backdrop-blur-[...]` (the latter's
// `backdrop-` prefix means `blur` doesn't start at a class-token BOUNDARY,
// so it needs its own alternative rather than relying on the shared
// boundary-anchored pattern).
const BLUR_RE = new RegExp(`${BOUNDARY}(!?)(backdrop-blur|blur)-\\[([^\\]]+)\\]`, "g");
const DROP_SHADOW_RE = new RegExp(`${BOUNDARY}(!?)drop-shadow-\\[([^\\]]+)\\]`, "g");

// bg-[linear-gradient(...)] / bg-[radial-gradient(...)] / bg-[conic-gradient(...)]
// - continuing Batch 1's --gradient-extract-* family (see registerGradientToken).
// Matched separately from the generic VAR_* regexes below since these are not
// var() passthrough; they need the `image:` paren hint (Batch 1 convention).
const GRADIENT_RE = new RegExp(
  `${BOUNDARY}(!?)bg-\\[((?:linear|radial|conic)-gradient\\([^\\]]*\\))\\]`,
  "g",
);

// bg|text|border-[var(--x)] (no fallback) and bg|text|border-[var(--x,fallback)]
// (with fallback). The fallback variant's raw capture includes everything up
// to the matching `)]` - since none of these fallback values contain nested
// brackets, a simple `[^\]]+` capture is safe (verified by inspection of all
// matching sites in this batch).
const VAR_NOFALLBACK_RE = new RegExp(
  `${BOUNDARY}(!?)(bg|text|border)-\\[var\\((--[a-zA-Z0-9-]+)\\)\\]`,
  "g",
);
const VAR_FALLBACK_RE = new RegExp(
  `${BOUNDARY}(!?)(bg|text|border)-\\[var\\((--[a-zA-Z0-9-]+),([^\\]]+)\\)\\]`,
  "g",
);

function rewriteFile(filePath, relPath) {
  const original = readFileSync(filePath, "utf8");
  let content = original;
  let siteCount = 0;

  content = content.replace(GRID_COLS_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (grid-cols-[${raw}]).`;
    const name = registerGtcToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}grid-cols-(--${name})`;
  });

  content = content.replace(GRID_ROWS_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (grid-rows-[${raw}]).`;
    const name = registerGtrToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}grid-rows-(--${name})`;
  });

  content = content.replace(TRANSITION_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (transition-[${raw}]).`;
    const name = registerTpToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}transition-(--${name})`;
  });

  content = content.replace(Z_RE, (match, bang, raw) => {
    const sourceNote = `Extracted from ${relPath} (z-[${raw}]).`;
    const name = registerZToken(raw, sourceNote);
    siteCount++;
    return `${bang}z-(--${name})`;
  });

  content = content.replace(SCALE_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (scale-[${raw}]).`;
    const name = registerSToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}scale-(--${name})`;
  });

  content = content.replace(EASE_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (ease-[${raw}]).`;
    const name = registerEToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}ease-(--${name})`;
  });

  content = content.replace(ALIGN_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (align-[${raw}]).`;
    const name = registerVaToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}align-(--${name})`;
  });

  content = content.replace(STROKE_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (stroke-[${raw}]).`;
    const name = registerSwToken(unescaped, sourceNote);
    siteCount++;
    // stroke-WIDTH requires the `length:` hint (bare stroke-(--x) is
    // ambiguous with the stroke-COLOR utility) - confirmed in Step 0 spike.
    return `${bang}stroke-(length:--${name})`;
  });

  content = content.replace(DROP_SHADOW_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (drop-shadow-[${raw}]).`;
    const name = registerDropShadowToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}drop-shadow-(--${name})`;
  });

  // Gradient bg-[...] brackets must be rewritten BEFORE the generic var()
  // passthrough regexes below (a gradient value can itself contain
  // `var(--x)` sub-expressions, e.g. hsl(var(--primary)), which the generic
  // VAR_NOFALLBACK_RE must not also try to match against the outer bg-[...]).
  content = content.replace(GRADIENT_RE, (match, bang, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (bg-[${raw}]).`;
    const name = registerGradientToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}bg-(image:--${name})`;
  });

  content = content.replace(BLUR_RE, (match, bang, util, raw) => {
    const unescaped = unescapeSpaces(raw);
    const sourceNote = `Extracted from ${relPath} (${util}-[${raw}]).`;
    const name = registerBlurToken(unescaped, sourceNote);
    siteCount++;
    return `${bang}${util}-(--${name})`;
  });

  // var(--x, fallback) forms MUST be rewritten before the no-fallback form
  // (which would otherwise partially match the `var(--x` prefix of a
  // fallback expression and corrupt it - the fallback regex requires a
  // literal comma so there's no real ambiguity, but ordering fallback-first
  // keeps the intent explicit and avoids relying on regex engine match order).
  content = content.replace(VAR_FALLBACK_RE, (match, bang, util, varName, fallbackRaw) => {
    const sourceNote = `Extracted from ${relPath} (${util}-[var(${varName},${fallbackRaw})]).`;
    const name = registerResolvedVarToken(varName, fallbackRaw, sourceNote);
    siteCount++;
    return `${bang}${util}-(--${name})`;
  });

  content = content.replace(VAR_NOFALLBACK_RE, (match, bang, util, varName) => {
    siteCount++;
    // Bare var() passthrough - no new token minted, per DESIGN.md/Batch 3's
    // special case for runtime library/component variables. Here the vars
    // already exist as first-class design tokens in index.css (--chip-match-*),
    // so this is a pure syntax modernization, not a token mint.
    return `${bang}${util}-(${varName})`;
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
  const marker = "/* ── Extracted verbatim MISC tokens (Phase 2 Batch 4, design/token-extraction) ── */";
  let cssNext = cssOriginal;
  let cssChanged = false;

  const anyTokens =
    gtcTokens.size ||
    gtrTokens.size ||
    tpTokens.size ||
    zTokens.size ||
    sTokens.size ||
    eTokens.size ||
    vaTokens.size ||
    swTokens.size ||
    blurTokens.size ||
    dropShadowTokens.size ||
    resolvedVarTokens.size ||
    gradientTokens.size;

  if (!cssOriginal.includes(marker) && anyTokens) {
    const lines = [];
    lines.push(marker);
    lines.push("/* Batch 4/4 (final sweep): grid track lists, transition-property");
    lines.push("   lists, z-index, scale, easing, vertical-align, stroke-width, blur,");
    lines.push("   drop-shadow, and half-migrated var(x, fallback) color forms,");
    lines.push("   verbatim (no normalizing - the human scale-collapse decision comes");
    lines.push("   later per DESIGN.md/TOKEN-AUDIT.md). --gtc-* and --gtr-* and --tp-* are");
    lines.push("   sequentially numbered / slugged since their content (track lists,");
    lines.push("   property lists) is not safely nameable by value alone.");
    lines.push("");
    lines.push("   drop-shadow (a CSS filter function) gets its own");
    lines.push("   --drop-shadow-extract-* family, kept separate from Batch 3's");
    lines.push("   --shadow-extract-* box-shadow family per that batch's logged");
    lines.push("   human-decision note.");
    lines.push("");
    lines.push("   *-resolved wrapper tokens hold a verbatim var(--x, fallback)");
    lines.push("   expression for sites where Tailwind v4's paren-with-fallback-comma");
    lines.push("   shorthand does not parse (confirmed unsupported in this batch's");
    lines.push("   Step 0 syntax spike). theme(colors.a.b) fallbacks were resolved to");
    lines.push("   the equivalent var(--token) form the Tailwind build already");
    lines.push("   compiles them to today (inspected byte-for-byte from the built");
    lines.push("   storybook-static CSS before this codemod ran: theme(colors.muted.DEFAULT)");
    lines.push("   -> var(--muted), theme(colors.muted.foreground) -> var(--muted-foreground)).");
    lines.push("");
    lines.push("   --gradient-extract-* here CONTINUES Batch 1's counter (Batch 1 minted");
    lines.push("   1 through 24) rather than restarting it - these 2 sites use");
    lines.push("   hsl(var(...))/color-mix(...) CSS-native color functions rather than raw");
    lines.push("   hex/rgb literals, which is why Batch 1's hand-audited color-literal");
    lines.push("   table did not catch them, but they are still value-bearing gradient");
    lines.push("   brackets in scope for this batch's final sweep.");
    lines.push("");
    lines.push("   Allowlist (sites intentionally left as-is - see ALLOWLIST doc-comment");
    lines.push("   at the end of this file for the machine-readable list consumed by");
    lines.push("   scripts/check-token-gates.mjs):");
    lines.push("   allow ui/src/components/ui/dialog.tsx — tw-animate-css plugin utilities (zoom-in-[0.97] etc.) are dead/no-op classes today (plugin not installed, verified via built-CSS grep); nothing to tokenize without visually changing a currently-inert class");
    lines.push("   allow ui/src/components/ui/alert-dialog.tsx — same tw-animate-css dead-class situation as dialog.tsx");
    lines.push("*/");
    lines.push(":root {");
    for (const [name, { value, comment }] of gtcTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of gtrTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of tpTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of zTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of sTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of eTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of vaTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of swTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of blurTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of dropShadowTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of resolvedVarTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    for (const [name, { value, comment }] of gradientTokens) {
      lines.push(`  --${name}: ${value}; /* ${comment} */`);
    }
    lines.push("}");
    const block = "\n" + lines.join("\n") + "\n";
    cssNext = cssOriginal + block;
    cssChanged = true;
  }

  if (cssChanged && !DRY_RUN) writeFileSync(cssPath, cssNext, "utf8");

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}codemod-extract-misc summary`);
  console.log(`  Sites rewritten:            ${totalSites}`);
  console.log(`  Files changed:              ${filesChanged}`);
  console.log(`  New --gtc-*:                ${gtcTokens.size}`);
  console.log(`  New --gtr-*:                ${gtrTokens.size}`);
  console.log(`  New --tp-*:                 ${tpTokens.size}`);
  console.log(`  New --z-*:                  ${zTokens.size}`);
  console.log(`  New --s-*:                  ${sTokens.size}`);
  console.log(`  New --e-*:                  ${eTokens.size}`);
  console.log(`  New --va-*:                 ${vaTokens.size}`);
  console.log(`  New --sw-*:                 ${swTokens.size}`);
  console.log(`  New --blur-*:               ${blurTokens.size}`);
  console.log(`  New --drop-shadow-extract-*: ${dropShadowTokens.size}`);
  console.log(`  New *-resolved wrapper:      ${resolvedVarTokens.size}`);
  console.log(`  New --gradient-extract-* (continuing Batch 1): ${gradientTokens.size}`);
  console.log(`  index.css token block:      ${cssChanged ? "added" : "already present or nothing to add (idempotent no-op)"}`);
  if (changedFiles.length) {
    console.log(`\n  Changed files:`);
    for (const f of changedFiles) console.log(`    - ${f}`);
  }
}

main();
