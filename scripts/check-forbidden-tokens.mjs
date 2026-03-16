#!/usr/bin/env node
/**
 * check-forbidden-tokens.mjs
 *
 * Scans the codebase for forbidden tokens before publishing to npm.
 * Mirrors the git pre-commit hook logic, but runs against the full
 * working tree (not just staged changes).
 *
 * Token list: .git/hooks/forbidden-tokens.txt (one per line, # comments ok).
 * If the file is missing, the check passes silently — other developers
 * on the project won't have this list, and that's fine.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const gitDir = execSync("git rev-parse --git-dir", { encoding: "utf8", cwd: repoRoot }).trim();
const tokensFile = resolve(repoRoot, gitDir, "hooks/forbidden-tokens.txt");

if (!existsSync(tokensFile)) {
  console.log("  ℹ  Forbidden tokens list not found — skipping check.");
  process.exit(0);
}

const tokens = readFileSync(tokensFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

if (tokens.length === 0) {
  console.log("  ℹ  Forbidden tokens list is empty — skipping check.");
  process.exit(0);
}

// Use git grep to search tracked files only (avoids node_modules, dist, etc.)
let found = false;

for (const token of tokens) {
  try {
    const result = execSync(
      `git grep -in --no-color -- ${JSON.stringify(token)} -- ':!pnpm-lock.yaml' ':!.git'`,
      { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.trim()) {
      if (!found) {
        console.error("ERROR: Forbidden tokens found in tracked files:\n");
      }
      found = true;
      // Print matches but DO NOT print which token was matched (avoids leaking the list)
      const lines = result.trim().split("\n");
      for (const line of lines) {
        console.error(`  ${line}`);
      }
    }
  } catch {
    // git grep returns exit code 1 when no matches — that's fine
  }
}

if (found) {
  console.error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
  process.exit(1);
} else {
  console.log("  ✓  No forbidden tokens found.");
}
