#!/usr/bin/env node
/**
 * check-token-gates.mjs
 *
 * Phase 2 (extraction) DONE-WHEN gate check for the design-token-extraction
 * run (branch design/token-extraction; see DESIGN.md, GOAL-PROMPT.md,
 * TOKEN-AUDIT.md). Scans `ui/src/components/**` and `ui/src/pages/**`
 * (excluding `ui/src/lib|context|plugins`, which are explicitly out of
 * scope for this run per TOKEN-AUDIT.md's Batch 4 log) for three gates:
 *
 *   Gate 1 — zero hardcoded COLOR LITERALS: hex colors (#fff, #ffffff,
 *     #ffffffff) and rgb()/rgba()/hsl()/hsla()/oklch() value literals
 *     (i.e. NOT a var() reference, and not merely referencing a CSS
 *     variable inside one of those functions, e.g. hsl(var(--primary)) is
 *     fine — only a literal numeric color argument fails the gate).
 *
 *   Gate 2 — zero VALUE-BEARING arbitrary Tailwind bracket utilities:
 *     bracket contents (`utility-[...]`) that carry a rendered CSS value
 *     (digits with CSS units, bare numbers, color literals, or CSS value
 *     functions like calc()/min()/max()/clamp()/var()/linear-gradient()/
 *     cubic-bezier()/rgba()/env()). This is checked on the UTILITY
 *     position, i.e. `word-[...]` where `word` is not itself a selector/
 *     variant keyword.
 *
 *     SELECTOR/VARIANT BRACKETS ARE EXCLUDED BY DEFINITION, not by
 *     omission: `data-[...]`, `group-data-[...]`, `has-[...]`,
 *     `group-has-data-[...]`, `aria-[...]`, `supports-[...]`, and
 *     `max-[...]`/`min-[...]` used as a BREAKPOINT VARIANT PREFIX (i.e.
 *     immediately followed by `:`, such as `max-[480px]:hidden`) are CSS
 *     SELECTOR CONDITIONS or responsive variant prefixes, not visual
 *     values applied to a property — they describe WHEN a rule applies,
 *     not WHAT value it sets. A variant's bracket cannot reference a CSS
 *     custom property (Tailwind resolves variants at build time, before
 *     any `var()` could be evaluated), so there is nothing to tokenize;
 *     tokenizing would require changing Tailwind's own variant syntax,
 *     which is out of scope. These are recognized structurally: a
 *     bracket immediately followed by `:` (not part of a class string's
 *     trailing utility) is a variant, not a utility value.
 *
 *     True exceptions that DO carry a value but cannot be tokenized are
 *     ALLOWLISTED, not silently excluded (see ALLOWLIST parsing below):
 *     `max-[480px]`/`min-[420px]` breakpoint variants (variant position
 *     cannot reference a var), and `rounded-[inherit]` (a CSS-wide
 *     keyword, not a literal value, cannot come from a custom property).
 *
 *   Gate 3 — zero raw FONT-SIZE declarations: `text-[Npx]`/`text-[N.Nrem]`
 *     Tailwind arbitrary font-size utilities (a subset of gate 2, checked
 *     explicitly since font-size is its own DESIGN.md-named category) and
 *     `fontSize: "..."` / `font-size:` string-literal declarations in
 *     inline styles or css-in-js.
 *
 * The ALLOWLIST is parsed from the machine-readable block in
 * ui/src/index.css (search for "── ALLOWLIST" below it), one entry per
 * line in the form:
 *   * allow <repo-relative-path> — <reason>
 * A violation at a path is suppressed if the path CONTAINS (substring
 * match) any allowlisted path. This intentionally allowlists the whole
 * file for simplicity/reviewability, matching how Batches 1-3 allowlisted
 * entire sites' surrounding functional code rather than individual
 * characters.
 *
 * Exit code: 0 if all three gates are clean (prints a per-gate summary).
 * Exit code: 1 if any gate has violations (lists them, grouped by gate).
 *
 * Usage: node scripts/check-token-gates.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_SRC = resolve(REPO_ROOT, "ui/src");
const SCAN_DIRS = ["components", "pages"];
const CSS_PATH = resolve(UI_SRC, "index.css");

// ── Allowlist parsing ────────────────────────────────────────────────────
// Reads the machine-readable "* allow <path> — <reason>" lines from the
// ALLOWLIST block in ui/src/index.css. Tolerant of either em-dash (—) or
// a plain hyphen-minus as the path/reason separator, and of the historical
// per-batch prose blocks NOT being in this format (they are not parsed;
// only lines starting with "* allow " are).
function loadAllowlist(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  const entries = [];
  const lineRe = /^\s*\*\s*allow\s+(\S+)\s+(?:—|-{1,2})\s*(.*)$/;
  for (const rawLine of css.split("\n")) {
    const m = rawLine.match(lineRe);
    if (m) {
      entries.push({ path: m[1], reason: m[2].trim() });
    }
  }
  return entries;
}

function isAllowlisted(relPath, allowlist) {
  return allowlist.some((entry) => relPath.includes(entry.path));
}

// ── File walking ─────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
}

function listFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(resolve(UI_SRC, dir), files);
  files.sort();
  return files;
}

// ── Gate 1: color literals ───────────────────────────────────────────────
// Hex colors: #abc, #aabbcc, #aabbccdd — word-boundary guarded so it
// doesn't match inside identifiers, and NOT preceded by another hex digit
// (avoids over-matching truncated substrings of longer non-color tokens,
// though `#` itself is a strong enough anchor in practice).
// A genuine CSS hex color is never glued directly to an identifier
// character (letter/digit/underscore) or `/` immediately before the `#` —
// that shape is an issue/PR reference like "acme/web#241" or "acme/web#12"
// (Batch 1's codemod header documented this exact false-positive risk for
// its own hex-literal sweep; the same guard applies here). A real color
// literal is preceded by a delimiter (quote, colon, paren, comma,
// whitespace, backtick, template `${`) or sits at the start of the string.
const HEX_COLOR_RE = /(?<![a-zA-Z0-9_/])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

// rgb()/rgba()/hsl()/hsla()/oklch() with a LITERAL first argument (a digit,
// a `.` decimal, or a `%` — i.e. not `var(` or `calc(` immediately inside).
// `hsl(var(--x)/0.16)` must NOT match (var() reference); `rgba(0,0,0,0.5)`
// MUST match (literal numeric channels).
const COLOR_FN_LITERAL_RE = /\b(?:rgb|rgba|hsl|hsla|oklch)\(\s*(?!var\()[0-9.%-]/g;

function findColorLiteralIssues(content) {
  const issues = [];
  for (const m of content.matchAll(HEX_COLOR_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(COLOR_FN_LITERAL_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

// ── Gate 2: value-bearing arbitrary bracket utilities ───────────────────
// Matches `word-[content]` (optionally prefixed by `!`, and optionally
// preceded by a Tailwind variant chain like `sm:` / `dark:` / `hover:` /
// `data-[state=open]:` etc. — the regex only needs to find the utility's
// OWN bracket, not parse the whole variant chain, since VARIANT_KEYWORDS
// below excludes variant-shaped words directly at the match site).
//
// A bracket is a VARIANT (excluded by definition, see header) if:
//   (a) the word immediately before `-[` is one of the known variant
//       keywords (data, group-data, has, group-has-data, aria, supports,
//       group-aria, peer-data, peer-aria, in, not), OR
//   (b) the bracket is immediately followed by `:` (a breakpoint-style
//       variant prefix, e.g. `max-[480px]:hidden` — the `:` right after
///      `]` is the structural signal that this bracket is a CONDITION,
//       not a value).
const BRACKET_RE = /(!?)([a-zA-Z][a-zA-Z0-9-]*)-\[([^\[\]]*)\]/g;

const VARIANT_WORD_RE =
  /(?:^|[\s"'`{])(?:group-|peer-)?(?:data|has|aria|supports|in|not)(?:-[a-zA-Z0-9]+)*$/;

// A bracket carries a VALUE (not just a keyword/selector fragment) if its
// content looks like: a number (optionally with a CSS unit or %), a CSS
// color literal (# hex or a color function), OR a known CSS value function
// call (calc/min/max/clamp/var/env/linear-gradient/radial-gradient/
// conic-gradient/cubic-bezier/rgba/rgb/hsl/hsla/oklch). Pure CSS KEYWORDS
// (e.g. `inherit`, `auto`, `pointer`) do NOT match and are not gated here
// (they're a separate, allowlisted concern — see `rounded-[inherit]`).
const VALUE_UNIT_RE = /^-?[0-9.]+(?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|s|ms|fr)?$/;
const VALUE_FUNC_RE =
  /^(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/;
const HEX_ONLY_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function bracketCarriesValue(raw) {
  const trimmed = raw.trim();
  if (VALUE_UNIT_RE.test(trimmed)) return true;
  if (HEX_ONLY_RE.test(trimmed)) return true;
  if (VALUE_FUNC_RE.test(trimmed)) return true;
  // A bracket containing an embedded CSS value function anywhere (e.g. a
  // grid track list `56px_56px_24px_minmax(0,1fr)` that doesn't itself
  // start with one of the above, or `translate-y-[-50%]`-style negative
  // percentages already covered by VALUE_UNIT_RE) also counts.
  if (/[0-9](?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|fr)\b/.test(trimmed)) return true;
  if (/\b(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/.test(trimmed)) return true;
  if (HEX_COLOR_RE.test(trimmed)) return true;
  return false;
}

function findArbitraryBracketIssues(content) {
  const issues = [];
  for (const m of content.matchAll(BRACKET_RE)) {
    const [full, , word, raw] = m;
    const matchEnd = m.index + full.length;
    const followedByColon = content[matchEnd] === ":";
    if (followedByColon) continue; // breakpoint/arbitrary-variant prefix, not a utility value

    // Reject if `word` itself IS (or ends in) a variant keyword shape, e.g.
    // a match that accidentally captured "...data" as the utility name for
    // some malformed/edge case. In practice BRACKET_RE's utility-name
    // capture group only ever contains real utility names (data-[...] etc.
    // are matched with `word` = "data", "group-data", "has", etc.).
    const precedingContext = content.slice(Math.max(0, m.index - 1), m.index + word.length + 1);
    if (VARIANT_WORD_RE.test(precedingContext)) continue;
    if (/^(?:data|has|aria|supports|group-data|group-has-data|group-aria|peer-data|peer-aria|group-has-data-slot|in|not)$/.test(word)) {
      continue;
    }

    if (!raw.includes("[") && bracketCarriesValue(raw)) {
      issues.push({ index: m.index, snippet: `${word}-[${raw}]` });
    }
  }
  return issues;
}

// ── Gate 3: raw font-size declarations ──────────────────────────────────
const FONT_SIZE_CLASS_RE = /\btext-\[(?:[0-9.]+(?:px|rem|em)|[0-9.]+\/[0-9.]+)\]/g;
// A raw literal font-size value: starts with a digit (px/rem/em number) —
// EXCLUDES `fontSize: "var(--text-micro)"`-style token references, which start
// with `var(` and are the desired post-extraction form, not a violation.
const FONT_SIZE_INLINE_RE = /\bfontSize\s*:\s*["'][0-9][^"']*["']/g;
const FONT_SIZE_CSS_PROP_RE = /(?<!-)\bfont-size\s*:\s*["'`][0-9][^"'`]*["'`]/g;

function findFontSizeIssues(content) {
  const issues = [];
  for (const m of content.matchAll(FONT_SIZE_CLASS_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_INLINE_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_CSS_PROP_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function main() {
  const allowlist = loadAllowlist(CSS_PATH);
  const files = listFiles();

  const violations = { gate1: [], gate2: [], gate3: [] };
  let allowlistedSkips = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    const relPathPosix = relPathToPosix(filePath);

    const allowed = isAllowlisted(relPathPosix, allowlist);

    const g1 = findColorLiteralIssues(content);
    const g2 = findArbitraryBracketIssues(content);
    const g3 = findFontSizeIssues(content);

    if (allowed) {
      allowlistedSkips += g1.length + g2.length + g3.length;
      continue;
    }

    for (const issue of g1) {
      violations.gate1.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g2) {
      violations.gate2.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g3) {
      violations.gate3.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
  }

  const totalViolations = violations.gate1.length + violations.gate2.length + violations.gate3.length;

  console.log("check-token-gates summary");
  console.log(`  Files scanned:                 ${files.length}`);
  console.log(`  Allowlist entries loaded:      ${allowlist.length}`);
  console.log(`  Allowlisted issues skipped:    ${allowlistedSkips}`);
  console.log("");
  console.log(`  Gate 1 (color literals):       ${violations.gate1.length === 0 ? "CLEAN" : `${violations.gate1.length} violation(s)`}`);
  console.log(`  Gate 2 (arbitrary bracket vals): ${violations.gate2.length === 0 ? "CLEAN" : `${violations.gate2.length} violation(s)`}`);
  console.log(`  Gate 3 (raw font-size):        ${violations.gate3.length === 0 ? "CLEAN" : `${violations.gate3.length} violation(s)`}`);

  if (totalViolations > 0) {
    console.log("\nViolations:\n");
    for (const [gateName, list] of Object.entries(violations)) {
      if (list.length === 0) continue;
      console.log(`── ${gateName} ──`);
      for (const v of list) {
        console.log(`  ${v.file}:${v.line}  ${v.snippet}`);
      }
      console.log("");
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nAll gates clean.");
  process.exitCode = 0;
}

// Windows path separators never appear in this repo's CI, but keep relative
// paths POSIX-style for allowlist substring matching regardless of platform.
function relPathToPosix(filePath) {
  return ("ui/src/" + relative(UI_SRC, filePath)).split("\\").join("/");
}

main();
