#!/usr/bin/env node
/**
 * check-no-git-push.mjs
 *
 * Static check that rejects `git push` (and equivalent remote-mutating git
 * invocations) inside adapter/runtime source code.
 *
 * Adapter and runtime code may never push to a git remote: the local
 * execution-workspace cwd is the only persistence boundary between runs
 * (see packages/adapters/AUTHORING.md and PAPA-432). Release tooling and
 * developer scripts that legitimately push are out of scope because they
 * live outside the directories scanned here.
 *
 * Opt-in mechanism: a line containing `paperclip:allow-git-push` (typically
 * inside a `// paperclip:allow-git-push: <reason>` comment on the line itself
 * or the line immediately above) suppresses the match. This is reserved for
 * operator-configured paths that legitimately push and must be reviewed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = [
  "packages/adapters",
  "packages/adapter-utils",
  "server/src",
  "cli/src",
];

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
]);

const SKIP_FILENAME_SUFFIXES = [".d.ts"];

// Matches actual git push invocations in either:
//   `git push ...` (shell command string)
//   ["git", "push", ...] (args-array form for execSync)
//   execFile("git", ["push", ...]) / spawn("git", ["push", ...])
export const GIT_PUSH_PATTERNS = [
  /\bgit[\s_-]+push\b/i,
  /["'`]git["'`]\s*,\s*\[?\s*["'`]push["'`]/i,
];
// Kept for backwards-compatibility with existing tests/importers.
export const GIT_PUSH_PATTERN = GIT_PUSH_PATTERNS[0];
export const ALLOW_MARKER = "paperclip:allow-git-push";

function lineMatchesGitPush(line) {
  return GIT_PUSH_PATTERNS.some((pattern) => pattern.test(line));
}

function stripLineComment(line) {
  // Strip everything from the first `//` that is not inside a string literal.
  // This is a lightweight heuristic: we only need to remove obvious doc-style
  // mentions of "git push" so they do not trip the check. The check still
  // flags any match that survives comment stripping.
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    // A character is escaped only if it's preceded by an odd number of
    // backslashes; e.g. `"foo\\"` ends a string because the trailing `\\`
    // is a single escaped backslash, leaving the closing `"` unescaped.
    let backslashes = 0;
    for (let scan = index - 1; scan >= 0 && line[scan] === "\\"; scan -= 1) {
      backslashes += 1;
    }
    const isEscaped = backslashes % 2 === 1;

    if (!inDouble && !inBacktick && char === "'" && !isEscaped) inSingle = !inSingle;
    else if (!inSingle && !inBacktick && char === '"' && !isEscaped) inDouble = !inDouble;
    else if (!inSingle && !inDouble && char === "`" && !isEscaped) inBacktick = !inBacktick;
    else if (!inSingle && !inDouble && !inBacktick && char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }

  return line;
}

export function findGitPushOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = stripLineComment(line);
    if (!lineMatchesGitPush(stripped)) continue;

    const previousLine = index > 0 ? lines[index - 1] : "";
    const isAllowed = line.includes(ALLOW_MARKER) || previousLine.includes(ALLOW_MARKER);
    if (isAllowed) continue;

    offenses.push({ lineNumber: index + 1, line: line.trimEnd() });
  }

  return offenses;
}

function shouldScanFile(relativePath) {
  if (SKIP_FILENAME_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  const extension = path.extname(relativePath);
  return SCANNABLE_EXTENSIONS.has(extension);
}

export function collectScannableFiles(absoluteRoot, repoRoot) {
  const results = [];
  let stats;
  try {
    stats = statSync(absoluteRoot);
  } catch {
    return results;
  }
  if (!stats.isDirectory()) return results;

  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      if (shouldScanFile(relative)) results.push({ absolute, relative });
    }
  }

  return results;
}

export function runCheck({ repoRoot, scanRoots = DEFAULT_SCAN_ROOTS, log = console.log, error = console.error } = {}) {
  const allOffenses = [];

  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.resolve(repoRoot, scanRoot);
    const files = collectScannableFiles(absoluteRoot, repoRoot);
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file.absolute, "utf8");
      } catch {
        continue;
      }
      const offenses = findGitPushOffenses(text);
      for (const offense of offenses) {
        allOffenses.push({ relative: file.relative, ...offense });
      }
    }
  }

  if (allOffenses.length > 0) {
    error("ERROR: `git push` (or equivalent remote-mutating git command) found in adapter/runtime code:\n");
    for (const offense of allOffenses) {
      error(`  ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
    }
    error(
      "\nAdapter and runtime code must not push to a git remote. The local execution-workspace cwd is the only persistence boundary between runs (see packages/adapters/AUTHORING.md and PAPA-432).",
    );
    error(
      `If the operator has explicitly configured a path that must push, add a \`${ALLOW_MARKER}: <reason>\` comment on the matching line or the line immediately above to opt in.`,
    );
    return 1;
  }

  log(`  ✓  No unapproved \`git push\` invocations found in adapter/runtime code.`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  process.exit(runCheck({ repoRoot }));
}
