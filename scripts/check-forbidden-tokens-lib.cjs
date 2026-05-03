const { execSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const os = require("node:os");
const { resolve } = require("node:path");

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function resolveDynamicForbiddenTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];

  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

function readForbiddenTokensFile(tokensFile) {
  if (!existsSync(tokensFile)) return [];

  return readFileSync(tokensFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function resolveForbiddenTokens(tokensFile, env = process.env, osModule = os) {
  return uniqueNonEmpty([
    ...resolveDynamicForbiddenTokens(env, osModule),
    ...readForbiddenTokensFile(tokensFile),
  ]);
}

function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  exec = execSync,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }

  let found = false;

  for (const token of tokens) {
    try {
      const result = exec(
        `git grep -in --no-color -- ${JSON.stringify(token)} -- ':!pnpm-lock.yaml' ':!.git'`,
        { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
      );
      if (result.trim()) {
        if (!found) {
          error("ERROR: Forbidden tokens found in tracked files:\n");
        }
        found = true;
        const lines = result.trim().split("\n");
        for (const line of lines) {
          error(`  ${line}`);
        }
      }
    } catch {
      // git grep returns exit code 1 when no matches; that's fine.
    }
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    return 1;
  }

  log("  ✓  No forbidden tokens found.");
  return 0;
}

function resolveRepoPaths(exec = execSync) {
  const repoRoot = exec("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const gitDir = exec("git rev-parse --git-dir", { encoding: "utf8", cwd: repoRoot }).trim();
  return {
    repoRoot,
    tokensFile: resolve(repoRoot, gitDir, "hooks/forbidden-tokens.txt"),
  };
}

module.exports = {
  readForbiddenTokensFile,
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  resolveRepoPaths,
  runForbiddenTokenCheck,
};
