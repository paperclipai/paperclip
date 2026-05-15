#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function readOptionValue(index, optionName) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function hasManifestChange(changedPaths) {
  return changedPaths.some((changedPath) =>
    /(^|\/)package\.json$/.test(changedPath) ||
    changedPath === "pnpm-workspace.yaml" ||
    changedPath === ".npmrc" ||
    /^pnpmfile\.(cjs|js|mjs)$/.test(changedPath)
  );
}

function parseCliOptions() {
  let baseSha = process.env.GITHUB_BASE_SHA ?? "";
  let headSha = process.env.GITHUB_HEAD_SHA ?? "";
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--base") {
      baseSha = readOptionValue(index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--base=")) {
      baseSha = arg.slice("--base=".length);
      continue;
    }

    if (arg === "--head") {
      headSha = readOptionValue(index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--head=")) {
      headSha = arg.slice("--head=".length);
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument "${arg}"`);
  }

  if (!baseSha || !headSha) {
    throw new Error("Both --base and --head are required");
  }

  return { baseSha, headSha, dryRun };
}

function run(command, argsForCommand, options = {}) {
  const result = spawnSync(command, argsForCommand, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${argsForCommand.join(" ")} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

export function getChangedPaths(baseSha, headSha) {
  return run("git", ["diff", "--name-only", `${baseSha}...${headSha}`])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function prepareLockfile({ baseSha, headSha, dryRun = false }) {
  const changedPaths = getChangedPaths(baseSha, headSha);
  if (!hasManifestChange(changedPaths)) {
    console.log("[prepare-pr-lockfile] No manifest changes detected; using checked-in pnpm-lock.yaml.");
    return { refreshed: false, changedPaths };
  }

  console.log("[prepare-pr-lockfile] Manifest changes detected; refreshing pnpm-lock.yaml for this CI workspace.");
  if (!dryRun) {
    run("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"], { stdio: "inherit" });
  }
  return { refreshed: true, changedPaths };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    prepareLockfile(parseCliOptions());
  } catch (error) {
    console.error(`[prepare-pr-lockfile] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
