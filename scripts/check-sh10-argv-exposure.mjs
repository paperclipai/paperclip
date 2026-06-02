#!/usr/bin/env node
/**
 * check-sh10-argv-exposure.mjs
 *
 * Detects SH-10 violations: credentials shell-interpolated into CLI argument
 * strings, making them visible via `ps aux` and /proc/<pid>/cmdline.
 *
 * Prohibited patterns:
 *   Shell: curl -H "Authorization: Bearer $TOKEN" ...
 *          psql "postgresql://user:$PASS@host/db"
 *   JS/TS: execSync with template literal expanding a credential variable into a curl -H arg
 *          spawnSync with template literal expanding a credential variable into a connection URI
 *
 * Safe alternatives:
 *   Shell: curl --config <(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN")
 *   Shell: temp config file (chmod 600) — see help2day/SECRET_HANDLING_POLICY.md SH-10
 *   JS/TS: pass credentials via env var or a temp config file, not argv
 *
 * Opt-in escape hatch:
 *   Add `# sh10:allow-argv-credential: <reason>` (shell) or
 *       `// sh10:allow-argv-credential: <reason>` (JS/TS)
 *   on the matching line or the line immediately above to suppress.
 *
 * Policy: help2day/SECRET_HANDLING_POLICY.md SH-10 | Source: FUL-4346 | Prevention: FUL-6733
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ALLOW_MARKER = "sh10:allow-argv-credential";

const DEFAULT_SCAN_ROOTS = [
  "packages/adapters",
  "packages/adapter-utils",
  "server/src",
  "cli/src",
  "scripts",
  "skills",
];

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh"]);
const SHELL_EXTENSIONS = new Set([".sh"]);

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
]);

const SKIP_FILENAME_SUFFIXES = [".d.ts"];

// Self-exclude: the check script and its test file contain intentional examples
// of the prohibited pattern (in doc comments and test fixtures) that are not real violations.
const SKIP_RELATIVE_PATHS = new Set([
  "scripts/check-sh10-argv-exposure.mjs",
  "scripts/check-sh10-argv-exposure.test.mjs",
]);

/**
 * Shell-script patterns: match direct $VAR or ${VAR} interpolation in credential positions.
 * These are applied to .sh files where $VAR is always shell-expanded.
 */
export const SHELL_PATTERNS = [
  // Authorization: Bearer header with a shell variable (curl -H, wget --header)
  /\bAuthorization:\s+Bearer\s+\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/,
  // Connection URI with password variable: ://user:$PASS@ or ://:$PASS@
  /:\/\/[^:@\s#"']*:\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)@/,
];

/**
 * JS/TS patterns: match template-literal ${VAR} interpolation in exec/spawn call contexts.
 * Applied to .ts, .tsx, .js, .mjs, .cjs files.
 * Only flags ${VAR} (JS template literal syntax), not $VAR (which is just a literal string in JS).
 */
export const JS_PATTERNS = [
  // execSync/exec/spawn with inline Bearer credential interpolation on the same line
  /(?:execSync|\bexec|spawnSync|\bspawn)\s*\(.*Authorization:\s+Bearer\s+\$\{[A-Za-z_][A-Za-z0-9_]*\}/,
  // execSync/exec/spawn with connection URI password interpolation on the same line
  /(?:execSync|\bexec|spawnSync|\bspawn)\s*\(.*:\/\/[^:@\s'"]*:\$\{[A-Za-z_][A-Za-z0-9_]*\}@/,
];

/**
 * Strip a shell comment from a line (everything from # that is not inside quotes).
 * This prevents allow-marker comments from being matched by the violation patterns.
 */
export function stripShellComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function findShellOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : "";
    if (line.includes(ALLOW_MARKER) || prevLine.includes(ALLOW_MARKER)) continue;
    const stripped = stripShellComment(line);
    for (const pattern of SHELL_PATTERNS) {
      if (pattern.test(stripped)) {
        offenses.push({ lineNumber: i + 1, line: line.trimEnd() });
        break;
      }
    }
  }
  return offenses;
}

export function findJsOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : "";
    if (line.includes(ALLOW_MARKER) || prevLine.includes(ALLOW_MARKER)) continue;
    for (const pattern of JS_PATTERNS) {
      if (pattern.test(line)) {
        offenses.push({ lineNumber: i + 1, line: line.trimEnd() });
        break;
      }
    }
  }
  return offenses;
}

function shouldScanFile(relativePath) {
  if (SKIP_RELATIVE_PATHS.has(relativePath)) return false;
  if (SKIP_FILENAME_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  const ext = path.extname(relativePath);
  return SCANNABLE_EXTENSIONS.has(ext);
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

export function runCheck({
  repoRoot,
  scanRoots = DEFAULT_SCAN_ROOTS,
  log = console.log,
  error = console.error,
} = {}) {
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
      const ext = path.extname(file.relative);
      const offenses = SHELL_EXTENSIONS.has(ext)
        ? findShellOffenses(text)
        : findJsOffenses(text);
      for (const offense of offenses) {
        allOffenses.push({ relative: file.relative, ...offense });
      }
    }
  }

  if (allOffenses.length > 0) {
    error(
      "ERROR: SH-10 violation — credentials interpolated into CLI argument strings (visible via `ps aux`):\n",
    );
    for (const offense of allOffenses) {
      error(`  ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
    }
    error(
      "\nThis makes credentials visible via `ps aux` and /proc/<pid>/cmdline (world-readable on Linux).",
    );
    error("Safe alternatives for shell scripts:");
    error(
      '  curl --config <(printf \'header = "Authorization: Bearer %s"\\n\' "$TOKEN") ...',
    );
    error("  PGPASSWORD=\"$DB_PASS\" psql -U user -h host -d db");
    error(
      "See help2day/SECRET_HANDLING_POLICY.md SH-10 for full pattern list and safe alternatives.",
    );
    error(
      `\nTo suppress a legitimate use, add \`# ${ALLOW_MARKER}: <reason>\` (shell) or`,
    );
    error(
      `\`// ${ALLOW_MARKER}: <reason>\` (JS/TS) on the matching line or the line above.`,
    );
    return 1;
  }

  log("  ✓  No SH-10 argv credential exposure patterns found.");
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  process.exit(runCheck({ repoRoot }));
}
