#!/usr/bin/env node

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import path, { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { linkSdkInto } from "./link-plugin-dev-sdk.mjs";

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
const releasePackageMapPath = path.join(repoRoot, "scripts", "release-package-map.mjs");

function parseWorkspaceEntries(workspaceText) {
  // Keep this aligned with the repo's block-sequence `packages:` format in
  // pnpm-workspace.yaml. If that file moves to a more complex YAML shape,
  // switch this parser to a real YAML parser instead of line matching.
  return workspaceText
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+)\s*$/)?.[1]?.trim() ?? null)
    .map((entry) => {
      if (!entry) return entry;
      return entry.replace(/^(['"])(.*)\1$/, "$2");
    })
    .filter(Boolean)
    .map((entry) => ({
      pattern: entry.startsWith("!") ? entry.slice(1) : entry,
      negated: entry.startsWith("!"),
    }));
}

function globToRegExp(pattern) {
  let regex = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${regex}$`);
}

function isWorkspacePackage(pkgDir, workspaceEntries) {
  let included = false;

  for (const entry of workspaceEntries) {
    if (globToRegExp(entry.pattern).test(pkgDir)) {
      included = !entry.negated;
    }
  }

  return included;
}

function listPublicPackages() {
  const output = execFileSync(
    process.execPath,
    [releasePackageMapPath, "list"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [dir, name] = line.split("\t");
      return { dir, name };
    });
}

function readPackageJson(pkgDir) {
  return JSON.parse(
    readFileSync(path.join(repoRoot, pkgDir, "package.json"), "utf8"),
  );
}

async function runCaptured(command, args, cwd, log) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env: {
        ...process.env,
        CI: "true",
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (stdout?.trim()) log(stdout.trimEnd());
    if (stderr?.trim()) log(stderr.trimEnd());
  } catch (error) {
    if (error.stdout?.toString().trim()) log(error.stdout.toString().trimEnd());
    if (error.stderr?.toString().trim()) log(error.stderr.toString().trimEnd());
    throw error;
  }
}

// Each standalone package installs into its own directory (`--ignore-workspace`)
// and builds into its own `dist`, so there is no shared mutable state between
// packages beyond pnpm's content-addressable global store, which is safe for
// concurrent access. Buffer each package's output and flush it as one block so
// interleaved parallel logs stay readable.
async function prepareAndBuildPackage(pkg) {
  const logs = [];
  const log = (line) => logs.push(line);

  const pkgDir = path.join(repoRoot, pkg.dir);
  const pkgJson = readPackageJson(pkg.dir);
  const nodeModulesDir = path.join(pkgDir, "node_modules");
  const packageLockfilePath = path.join(pkgDir, "pnpm-lock.yaml");

  log(`  Preparing standalone package ${pkg.name} (${pkg.dir})`);
  try {
    if (existsSync(nodeModulesDir)) {
      rmSync(nodeModulesDir, { force: true, recursive: true });
    }

    const installArgs = existsSync(packageLockfilePath)
      ? ["install", "--ignore-workspace", "--frozen-lockfile"]
      : [
        "install",
        "--ignore-workspace",
        "--no-lockfile",
        // Standalone packages intentionally avoid committed lockfile churn in the repo.
      ];

    await runCaptured("pnpm", installArgs, pkgDir, log);

    // The fresh install above wipes node_modules and no longer fires a
    // per-plugin postinstall (removed for supply-chain safety), so link the
    // in-repo @paperclipai/plugin-sdk that the build's tsc resolves against.
    linkSdkInto(pkgDir);

    if (pkgJson.scripts?.build) {
      await runCaptured("pnpm", ["run", "build"], pkgDir, log);
    } else {
      log("    i No build script; skipped build");
    }
  } finally {
    if (logs.length > 0) {
      console.log(logs.join("\n"));
    }
  }
}

export function resolveConcurrency(packageCount) {
  const raw = process.env.STANDALONE_BUILD_CONCURRENCY;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1, Math.min(parsed, packageCount));
    }
  }

  let cpus = 4;
  try {
    cpus = availableParallelism();
  } catch {
    // Fall back to the default when parallelism cannot be determined.
  }
  return Math.max(1, Math.min(cpus, packageCount));
}

// Bounded-concurrency task pool. Workers pull from a shared cursor so no more
// than `limit` tasks run at once. Every task is awaited even if an earlier one
// fails, and failures are aggregated (sorted by original index) so a single bad
// package neither aborts the others mid-flight nor hides which one broke.
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const failures = [];
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }
      try {
        results[current] = await worker(items[current], current);
      } catch (error) {
        failures.push({ index: current, error });
      }
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));

  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    const aggregate = new Error(
      `${failures.length} standalone package build(s) failed`,
    );
    aggregate.failures = failures;
    throw aggregate;
  }

  return results;
}

async function main() {
  const workspaceEntries = parseWorkspaceEntries(readFileSync(workspacePath, "utf8"));
  const standalonePackages = listPublicPackages()
    .filter(({ dir }) => !isWorkspacePackage(dir, workspaceEntries));

  if (standalonePackages.length === 0) {
    console.log("  i No standalone public packages detected outside the pnpm workspace");
    return;
  }

  const concurrency = resolveConcurrency(standalonePackages.length);
  console.log(
    `  Building ${standalonePackages.length} standalone package(s) with concurrency ${concurrency}`,
  );

  try {
    await runWithConcurrency(
      standalonePackages,
      concurrency,
      prepareAndBuildPackage,
    );
  } catch (error) {
    if (Array.isArray(error.failures)) {
      const names = error.failures
        .map(({ index }) => standalonePackages[index]?.name)
        .filter(Boolean)
        .join(", ");
      console.error(`  ✗ Failed standalone package build(s): ${names}`);
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
