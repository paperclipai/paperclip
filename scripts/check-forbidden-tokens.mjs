#!/usr/bin/env node
/**
 * check-forbidden-tokens.mjs
 *
 * Scans the codebase for forbidden tokens before publishing to npm.
 * Mirrors the git pre-commit hook logic, but runs against the full
 * working tree (not just staged changes).
 *
 * Token list: .git/hooks/forbidden-tokens.txt (one per line, # comments ok).
 * If the file is missing, the check still uses the active local username when
 * available. If username detection fails, the check degrades gracefully.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export {
  readForbiddenTokensFile,
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  runForbiddenTokenCheck,
} from "./check-forbidden-tokens-lib.js";
import { resolveForbiddenTokens, runForbiddenTokenCheck } from "./check-forbidden-tokens-lib.js";

function resolveRepoPaths(exec = execSync) {
  const repoRoot = exec("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const gitDir = exec("git rev-parse --git-dir", { encoding: "utf8", cwd: repoRoot }).trim();
  return {
    repoRoot,
    tokensFile: resolve(repoRoot, gitDir, "hooks/forbidden-tokens.txt"),
  };
}

function main() {
  const { repoRoot, tokensFile } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFile);
  process.exit(runForbiddenTokenCheck({ repoRoot, tokens }));
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
