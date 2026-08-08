#!/usr/bin/env node
/**
 * RBR-918 codemod: remove inline hook budgets from Vitest hooks that boot
 * embedded Postgres, so the centralized `hookTimeout` in each project's
 * vitest.config.ts applies. An inline budget wins over `--hookTimeout`, so a
 * per-file value cannot be corrected from CI configuration.
 *
 * Usage: node scripts/codemod-embedded-postgres-hook-budgets.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const dryRun = process.argv.includes("--dry-run");

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const files = execFileSync(
  "git",
  ["grep", "-l", "--", "startEmbeddedPostgresTestDatabase", "*.ts"],
  { encoding: "utf8", cwd: repoRoot },
)
  .split("\n")
  .filter((line) => line.trim().length > 0);

function readCallText(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return null;
}

/** Index (relative to callText) of the top-level comma before a numeric tail. */
function findTimeoutCommaOffset(callText) {
  const inner = callText.slice(1, -1);
  let depth = 0;
  let lastComma = -1;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) lastComma = i;
  }
  if (lastComma === -1) return null;
  if (!/^[0-9][0-9_]*$/.test(inner.slice(lastComma + 1).trim())) return null;
  return lastComma + 1; // +1 to shift past callText's leading "("
}

let totalRemoved = 0;
const touched = [];

for (const relPath of files) {
  const abs = path.join(repoRoot, relPath);
  let source = readFileSync(abs, "utf8");
  let removedInFile = 0;

  // Re-scan from the top after each rewrite; offsets shift as we splice.
  for (;;) {
    const hookRe = /\b(beforeAll|beforeEach)\s*\(/g;
    let rewrote = false;
    let match;
    while ((match = hookRe.exec(source)) !== null) {
      const openParen = match.index + match[0].length - 1;
      const callText = readCallText(source, openParen);
      if (!callText) continue;
      if (!callText.includes("startEmbeddedPostgresTestDatabase")) continue;
      const commaOffset = findTimeoutCommaOffset(callText);
      if (commaOffset === null) continue;

      // Splice out ", <number>" leaving the closing paren intact.
      const absComma = openParen + commaOffset;
      const closeParen = openParen + callText.length - 1;
      source = source.slice(0, absComma) + source.slice(closeParen);
      removedInFile += 1;
      rewrote = true;
      break;
    }
    if (!rewrote) break;
  }

  if (removedInFile > 0) {
    totalRemoved += removedInFile;
    touched.push({ file: relPath, removed: removedInFile });
    if (!dryRun) writeFileSync(abs, source, "utf8");
  }
}

console.log(
  `${dryRun ? "[dry-run] would remove" : "removed"} ${totalRemoved} inline hook budget(s) across ${touched.length} file(s)`,
);
for (const entry of touched) {
  console.log(`  ${entry.file} (${entry.removed})`);
}
