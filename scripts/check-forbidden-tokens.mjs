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

import { execSync, spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

export function resolveDynamicForbiddenTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];

  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

export function readForbiddenTokensFile(tokensFile) {
  if (!existsSync(tokensFile)) return [];

  return readFileSync(tokensFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function resolveForbiddenTokens(tokensFile, env = process.env, osModule = os) {
  return uniqueNonEmpty([
    ...resolveDynamicForbiddenTokens(env, osModule),
    ...readForbiddenTokensFile(tokensFile),
  ]);
}

export async function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  spawn = spawnChild,
  output = process.stderr,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }

  let found = false;
  let failed = false;
  const reportMatch = () => {
    if (!found) {
      error("ERROR: Forbidden tokens found in tracked files:\n");
    }
    found = true;
  };

  for (const token of tokens) {
    const result = await new Promise((resolveResult) => {
      let child;
      try {
        child = spawn(
          "git",
          ["grep", "-in", "--no-color", "--", token, "--", ":!pnpm-lock.yaml", ":!.git"],
          { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] },
        );
      } catch (err) {
        resolveResult({ failed: true, errorCode: err.code });
        return;
      }

      child.once("error", (err) => resolveResult({ failed: true, errorCode: err.code }));
      child.stdout.once("error", (err) => {
        child.kill();
        resolveResult({ failed: true, errorCode: err.code });
      });
      child.stdout.on("data", reportMatch);
      // Pipe with backpressure rather than retaining execSync's capped output buffer.
      child.stdout.pipe(output, { end: false });
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    });

    if (result.failed || result.signal || (result.code !== 0 && result.code !== 1)) {
      failed = true;
      error(`ERROR: Forbidden token scan failed (exit ${result.code ?? "unknown"}, signal ${result.signal ?? "none"}, error ${result.errorCode ?? "none"}).`);
    } else if (result.code === 0) {
      reportMatch();
    }
    // Only git grep's normal exit 1 means no matches.
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
  }
  if (failed) {
    error("\nBuild blocked. Forbidden token scan did not complete successfully.");
  }
  if (found || failed) return 1;

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

async function main() {
  const { repoRoot, tokensFile } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFile);
  process.exitCode = await runForbiddenTokenCheck({ repoRoot, tokens });
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch(() => {
    console.error("ERROR: Forbidden token check could not run.");
    process.exitCode = 1;
  });
}
