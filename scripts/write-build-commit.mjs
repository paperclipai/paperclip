#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export function parseBuildCommit(value) {
  const commit = value?.trim() ?? "";
  return FULL_SHA_RE.test(commit) ? commit.toLowerCase() : null;
}

export function resolveBuildCommit({
  environmentCommit = process.env.PAPERCLIP_BUILD_COMMIT,
  gitCommand = () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }),
} = {}) {
  const environmentBuildCommit = parseBuildCommit(environmentCommit);
  if (environmentBuildCommit) return environmentBuildCommit;

  try {
    return parseBuildCommit(gitCommand());
  } catch {
    return null;
  }
}

export function writeBuildCommitMarker(outputPath, opts = {}) {
  const buildCommit = resolveBuildCommit(opts);
  if (!buildCommit) {
    rmSync(outputPath, { force: true });
    return null;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${buildCommit}\n`, "utf8");
  return buildCommit;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error("Usage: write-build-commit.mjs <output-path>");
    process.exitCode = 1;
  } else {
    writeBuildCommitMarker(resolve(process.cwd(), outputPath));
  }
}
