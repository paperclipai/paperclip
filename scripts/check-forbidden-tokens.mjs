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

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveForbiddenTokens, resolveRepoPaths, runForbiddenTokenCheck } from "./check-forbidden-tokens-lib.js";

function main() {
  const { repoRoot, tokensFile } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFile);
  process.exit(runForbiddenTokenCheck({ repoRoot, tokens }));
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}

export { resolveDynamicForbiddenTokens, readForbiddenTokensFile } from "./check-forbidden-tokens-lib.js";
