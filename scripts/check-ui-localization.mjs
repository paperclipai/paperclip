#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const UI_SRC = join(REPO_ROOT, "ui", "src");

const FILE_EXTENSIONS = new Set([".ts", ".tsx"]);
const EXCLUDED_SEGMENTS = new Set(["node_modules", "dist"]);
const EXCLUDED_PATH_FRAGMENTS = [
  join("ui", "src", "i18n"),
  join("ui", "src", "fixtures"),
];
const EXCLUDED_SUFFIXES = [".test.ts", ".test.tsx"];

const CHECKS = [
  {
    name: "inline-locale-branch",
    regex: /locale\s*===\s*["'](?:en|ko|ja)["']/g,
    message: "Inline locale branching is not allowed in UI sources; use catalogs instead.",
  },
  {
    name: "pick-locale-text-helper",
    regex: /pickLocaleText\s*\(/g,
    message: "pickLocaleText() should not appear in UI sources; use the i18n layer instead.",
  },
  {
    name: "three-arg-tr-call",
    regex: /\btr\(\s*\"[^\"]*\"\s*,\s*\"[^\"]*\"\s*,\s*\"[^\"]*\"\s*\)/g,
    message: "Three-argument tr(...) calls are transitional and should be externalized.",
  },
];

function shouldSkip(file) {
  const normalized = relative(REPO_ROOT, file);
  if (EXCLUDED_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true;
  if (EXCLUDED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return false;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (FILE_EXTENSIONS.has(extname(full)) && !shouldSkip(full)) {
      files.push(full);
    }
  }
  return files;
}

function lineNumberFor(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

const offenders = [];
for (const file of walk(UI_SRC)) {
  const source = readFileSync(file, "utf8");
  for (const check of CHECKS) {
    check.regex.lastIndex = 0;
    let match;
    while ((match = check.regex.exec(source))) {
      offenders.push({
        file: relative(REPO_ROOT, file),
        line: lineNumberFor(source, match.index),
        check: check.name,
        message: check.message,
        snippet: match[0],
      });
    }
  }
}

if (offenders.length > 0) {
  console.error("UI localization guard failed. Remove transitional localization patterns:\n");
  for (const offender of offenders) {
    console.error(`- ${offender.file}:${offender.line} [${offender.check}]`);
    console.error(`  ${offender.message}`);
    console.error(`  ${offender.snippet}`);
  }
  process.exit(1);
}

console.log("✓ UI localization guard passed.");
