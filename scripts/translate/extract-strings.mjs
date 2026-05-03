#!/usr/bin/env node
/**
 * extract-strings.mjs
 *
 * Walks ui/src/**\/*.tsx and reports likely-translatable strings
 * (JSX text nodes, string props like title/placeholder/aria-label/alt).
 *
 * Output:
 *   report/translate/extract-report.json   — machine-readable
 *   report/translate/extract-report.md     — human-readable summary
 *
 * Usage:
 *   node scripts/translate/extract-strings.mjs
 *   node scripts/translate/extract-strings.mjs --dir ui/src/pages
 *   node scripts/translate/extract-strings.mjs --json-only
 *
 * This is a heuristic scanner, not a full AST parser. False positives are
 * expected (e.g. CSS class names that look like English). The output is a
 * starting point for human/agent review, not a drop-in replacement.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit } from "node:process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..", "..");

// ─── args ────────────────────────────────────────────────────────────────────

const args = argv.slice(2);
const opts = {
  dir: "ui/src",
  jsonOnly: false,
};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && args[i + 1]) {
    opts.dir = args[i + 1];
    i++;
  } else if (args[i] === "--json-only") {
    opts.jsonOnly = true;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(
      "Usage: extract-strings.mjs [--dir <path>] [--json-only]",
    );
    exit(0);
  }
}

const SCAN_DIR = join(ROOT, opts.dir);
const OUT_DIR = join(ROOT, "report", "translate");

// ─── walk ────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "storybook-static",
  "i18n",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// ─── scanners ────────────────────────────────────────────────────────────────

// JSX text nodes between tags: >Some Text<
//   - Must start with a letter
//   - Must contain at least one space (avoid catching class fragments)
//   - Reasonable length
const RE_JSX_TEXT = />([A-Z][\w\s,.\-!?'"():/]{2,200}[\w.!?'")])</g;

// Common string props that hold user-facing text
const RE_STRING_PROP =
  /\b(title|placeholder|aria-label|alt|tooltip|label)=(?:"([^"]{3,})"|'([^']{3,})')/g;

// Toast/notify-like calls: toast("..."), toast.error("..."), notify("...")
const RE_NOTIFY = /\b(toast|notify|alert|message)(?:\.\w+)?\(\s*["']([^"']{3,})["']/g;

// Strings to ignore entirely (URLs, paths, code fragments, css classes)
const RE_IGNORE = [
  /^https?:\/\//,
  /^\/[\w-]/,
  /^[A-Z][A-Z0-9_]+$/, // SHOUTY_CONSTANT
  /^[\w-]+\/[\w-]+$/, // mime/type
  /^\$\{/, // template literal
  /^#?[a-f0-9]{6,8}$/i, // hex color
  /^\d+(\.\d+)?(px|rem|em|%)?$/, // dimension
];

function shouldIgnore(s) {
  const trimmed = s.trim();
  if (trimmed.length < 3) return true;
  if (!/[a-zA-Z]/.test(trimmed)) return true;
  // Must contain a space OR be a single capitalized word of >=4 chars
  if (!/\s/.test(trimmed) && trimmed.length < 4) return true;
  for (const re of RE_IGNORE) if (re.test(trimmed)) return true;
  return false;
}

function scanFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const findings = [];

  lines.forEach((line, i) => {
    let m;

    RE_JSX_TEXT.lastIndex = 0;
    while ((m = RE_JSX_TEXT.exec(line)) !== null) {
      const s = m[1].trim();
      if (shouldIgnore(s)) continue;
      findings.push({ line: i + 1, type: "jsx-text", string: s });
    }

    RE_STRING_PROP.lastIndex = 0;
    while ((m = RE_STRING_PROP.exec(line)) !== null) {
      const s = (m[2] || m[3]).trim();
      if (shouldIgnore(s)) continue;
      findings.push({ line: i + 1, type: `prop:${m[1]}`, string: s });
    }

    RE_NOTIFY.lastIndex = 0;
    while ((m = RE_NOTIFY.exec(line)) !== null) {
      const s = m[2].trim();
      if (shouldIgnore(s)) continue;
      findings.push({ line: i + 1, type: `call:${m[1]}`, string: s });
    }
  });

  return findings;
}

// ─── run ─────────────────────────────────────────────────────────────────────

const files = walk(SCAN_DIR).sort();
const report = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const findings = scanFile(file);
  if (findings.length === 0) continue;
  report.push({ file: rel, findings });
}

const totalStrings = report.reduce((n, f) => n + f.findings.length, 0);
const uniqueStrings = new Set();
for (const f of report) for (const x of f.findings) uniqueStrings.add(x.string);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "extract-report.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scannedDir: opts.dir,
      filesWithStrings: report.length,
      totalFindings: totalStrings,
      uniqueStrings: uniqueStrings.size,
      report,
    },
    null,
    2,
  ),
);

if (!opts.jsonOnly) {
  const md = [
    `# Translation extraction report`,
    ``,
    `- Generated: ${new Date().toISOString()}`,
    `- Scanned: \`${opts.dir}\``,
    `- Files with translatable strings: **${report.length}**`,
    `- Total findings: **${totalStrings}**`,
    `- Unique strings: **${uniqueStrings.size}**`,
    ``,
    `> Heuristic scanner — false positives expected. Review before extracting.`,
    ``,
    `## Top files by string count`,
    ``,
    `| File | Strings |`,
    `| --- | ---: |`,
    ...report
      .slice()
      .sort((a, b) => b.findings.length - a.findings.length)
      .slice(0, 20)
      .map((r) => `| \`${r.file}\` | ${r.findings.length} |`),
    ``,
    `## Per-file detail (first 30 files)`,
    ``,
    ...report.slice(0, 30).flatMap((r) => [
      `### \`${r.file}\``,
      ``,
      `| Line | Type | String |`,
      `| ---: | --- | --- |`,
      ...r.findings.map(
        (f) =>
          `| ${f.line} | ${f.type} | ${f.string
            .replace(/\|/g, "\\|")
            .replace(/\n/g, " ")} |`,
      ),
      ``,
    ]),
  ].join("\n");
  writeFileSync(join(OUT_DIR, "extract-report.md"), md);
}

console.log(
  `Extracted ${totalStrings} candidate strings (${uniqueStrings.size} unique) ` +
    `from ${report.length} files in ${opts.dir}`,
);
console.log(`  → report/translate/extract-report.json`);
if (!opts.jsonOnly) console.log(`  → report/translate/extract-report.md`);
