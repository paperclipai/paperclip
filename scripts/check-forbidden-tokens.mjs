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

export function runForbiddenTokenCheck({
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
      // git grep returns exit code 1 when no matches — that's fine
    }
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    return 1;
  }

  log("  ✓  No forbidden tokens found.");
  return 0;
}

const CREDENTIAL_ENV_NAME =
  "(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|BYPASS|JWT|AUTH|CREDENTIAL)|PAPERCLIP_[A-Z0-9_]*|DATABASE_URL)";

const SHELL_PRINT_COMMAND_PATTERN = /\b(?:echo|printf)\b/;
const SHELL_CREDENTIAL_EXPANSION_PATTERN = new RegExp(
  String.raw`(?:\$(?:${CREDENTIAL_ENV_NAME})|\$\{(?:${CREDENTIAL_ENV_NAME})(?::[-+?=][^}]*)?\})`,
);

function shellPrintsCredentialToOutput(line) {
  if (!SHELL_PRINT_COMMAND_PATTERN.test(line)) return false;
  if (!SHELL_CREDENTIAL_EXPANSION_PATTERN.test(line)) return false;
  if (line.includes("::add-mask::")) return false;

  const redirection = line.match(/(?:^|\s)(?:\d?>|&>)\s*(\S+)/);
  if (!redirection) return true;

  const target = redirection[1];
  return target === "&1" || target === "&2" || target === "/dev/stdout" || target === "/dev/stderr";
}

const CREDENTIAL_OUTPUT_PATTERNS = [
  {
    name: "shell stdout/stderr credential expansion",
    matches: shellPrintsCredentialToOutput,
  },
  {
    name: "JavaScript process.env credential output",
    matches: (line) => new RegExp(
      String.raw`\b(?:console\.(?:log|error|warn|info|debug)|process\.(?:stdout|stderr)\.write)\s*\([^)]*process\.env(?:\.${CREDENTIAL_ENV_NAME}|\[['"]${CREDENTIAL_ENV_NAME}['"]\])`,
    ).test(line),
  },
  {
    name: "JavaScript full process.env serialization",
    matches: (line) =>
      /\b(?:console\.(?:log|error|warn|info|debug)|process\.(?:stdout|stderr)\.write)\s*\([^)]*(?:JSON\.stringify\s*\(\s*process\.env\s*\)|process\.env\s*\))/.test(
        line,
      ),
  },
];

const DEFAULT_SECRET_SAFETY_EXCLUDES = [
  "pnpm-lock.yaml",
  ".git",
  "docs/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.mjs",
  ".env*",
  "*.env",
  "**/*.env",
  ".vercel/**",
  "tmp-*.mjs",
  "tmp-*.js",
  "fix-*.js",
  "fix-*.mjs",
  "ful*-*.sh",
  "ful*-*.py",
  "**/tmp-*.mjs",
  "**/tmp-*.js",
  "**/fix-*.js",
  "**/fix-*.mjs",
  "**/ful*-*.sh",
  "**/ful*-*.py",
];

function toGitPathspecExcludes(excludes) {
  return excludes.map((exclude) => `':!${exclude}'`).join(" ");
}

export function findCredentialOutputPatternMatches({
  repoRoot,
  exec = execSync,
  readFile = readFileSync,
  excludes = DEFAULT_SECRET_SAFETY_EXCLUDES,
}) {
  const pathspecExcludes = toGitPathspecExcludes(excludes);
  let filesOutput = "";
  try {
    filesOutput = exec(`git ls-files -- ${pathspecExcludes}`, {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return [];
  }

  const matches = [];
  for (const file of filesOutput.split("\n").filter(Boolean)) {
    let content = "";
    try {
      content = readFile(resolve(repoRoot, file), "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const check of CREDENTIAL_OUTPUT_PATTERNS) {
        if (check.matches(line)) {
          matches.push({ file, line: index + 1, pattern: check.name });
          break;
        }
      }
    }
  }

  return matches;
}

export function runCredentialOutputPatternCheck({
  repoRoot,
  exec = execSync,
  readFile = readFileSync,
  log = console.log,
  error = console.error,
}) {
  const matches = findCredentialOutputPatternMatches({ repoRoot, exec, readFile });
  if (matches.length === 0) {
    log("  ✓  No credential stdout patterns found.");
    return 0;
  }

  error("ERROR: Credential stdout patterns found in tracked files:\n");
  for (const match of matches) {
    error(`  ${match.file}:${match.line}: ${match.pattern}`);
  }
  error("\nBuild blocked. Use a safe wrapper and report credential names only.");
  return 1;
}

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
  const forbiddenTokenExitCode = runForbiddenTokenCheck({ repoRoot, tokens });
  const credentialOutputExitCode = runCredentialOutputPatternCheck({ repoRoot });
  process.exit(forbiddenTokenExitCode || credentialOutputExitCode);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
