#!/usr/bin/env node
/**
 * Disconnect-handling guard: finds UI code that renders raw query
 * errors or opts out of the shared retry policy.
 *
 * During an outage the app shows one connection banner and keeps loaded data
 * on screen. These patterns break that:
 *
 *   raw-error-message   {error.message}, {query.error?.message}
 *   cast-error-message  {(error as Error).message}
 *   is-error-render     isError ? … / isError && …  (usually hides cached data)
 *   retry-false         retry: false  (skips transient retry; use the defaults
 *                       in ui/src/lib/query-client.ts)
 *
 * Use `describeError` (ui/src/api/errors.ts) for copy and render cached data
 * before errors. Intentional exceptions go in ALLOWLIST below as
 * "<path>:<rule>" with a reason.
 *
 * Report-only by default: prints findings and exits 0. `--enforce` exits 1
 * on any finding outside the allowlist (CI turns this on once surfaces migrate).
 *
 * Usage: node scripts/check-query-error-rendering.mjs [--enforce] [--summary]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultScanRoot = join(repoRoot, "ui/src");

export const RULES = [
  {
    id: "raw-error-message",
    description: "renders a raw error message; use describeError()",
    pattern: /\{\s*[\w$.?!]*\b(?:error|err|e|[a-z]\w*Error)\s*[?!]?\.message\s*\}/,
  },
  {
    id: "cast-error-message",
    description: "renders a cast error message; use describeError()",
    pattern: /\{\s*\(\s*[\w$.?!]+\s+as\s+(?:Error|ApiError)\s*\)\s*\??\.message\s*\}/,
  },
  {
    id: "is-error-render",
    description: "branches rendering on isError; render cached data first",
    // `isError ?` / `isError &&`, not `isError?.x`, `isError ?? x`, or `isError?: boolean`.
    pattern: /\bisError\s*(?:\?(?![.?:])|&&)/,
  },
  {
    id: "retry-false",
    description: "disables retry; rely on the query-client defaults",
    pattern: /\bretry\s*:\s*false\b/,
  },
];

/**
 * Intentional exceptions, as "<repo-relative path>:<rule id>". Each entry needs
 * a reason. The list shrinks as surfaces migrate to the shared error handling.
 */
export const ALLOWLIST = new Set([
  // Empty for now: report-only mode lists every finding as the baseline.
]);

function isCheckable(path) {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.(test|spec|stories)\.(ts|tsx)$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  return true;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (isCheckable(full)) out.push(full);
  }
  return out;
}

/** Findings for one file's source text. Lines ending in `// query-error-ok` are skipped. */
export function scanSource(sourceText, path) {
  const findings = [];
  const lines = sourceText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/\/\/\s*query-error-ok\b/.test(line)) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) findings.push({ path, line: index + 1, rule: rule.id, text: trimmed });
    }
  }
  return findings;
}

export function scanQueryErrorRendering({ root = defaultScanRoot, allowlist = ALLOWLIST } = {}) {
  const findings = [];
  for (const file of walk(root, [])) {
    const path = relative(repoRoot, file).split(sep).join("/");
    for (const finding of scanSource(readFileSync(file, "utf8"), path)) {
      if (!allowlist.has(`${finding.path}:${finding.rule}`)) findings.push(finding);
    }
  }
  return findings;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const enforce = args.has("--enforce");
  const summaryOnly = args.has("--summary");
  const findings = scanQueryErrorRendering();

  if (!summaryOnly) {
    for (const finding of findings) {
      console.log(`${finding.path}:${finding.line}  [${finding.rule}]  ${finding.text}`);
    }
  }
  const files = new Set(findings.map((finding) => finding.path));
  console.log("");
  console.log(`check-query-error-rendering: ${findings.length} finding(s) in ${files.size} file(s)`);
  for (const rule of RULES) {
    const count = findings.filter((finding) => finding.rule === rule.id).length;
    console.log(`  ${rule.id.padEnd(20)} ${String(count).padStart(5)}  ${rule.description}`);
  }
  if (!enforce) {
    console.log("Report-only mode: not failing. Pass --enforce to fail on findings.");
    return;
  }
  if (findings.length > 0) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
