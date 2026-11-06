#!/usr/bin/env node
// Typechecks the test files that no build or package typecheck reads.
//
// Most package tsconfigs exclude tests so that `tsc` does not emit them, and
// Vitest strips types, so a type error in those tests fails nothing. Each program
// in PROGRAMS reads them without emitting. Sandbox providers are outside the
// workspace, so the root install has none of their dependencies. They install from
// typecheck-sandbox-providers/pnpm-lock.yaml here, because their SDK types are part
// of what a test checks.
//
// The script then fails if a tracked test file is in no program. tsc decides that,
// not a glob: `include` silently drops foo.test.tsx when foo.test.ts exists.
//
// Usage: node scripts/typecheck-test-programs.mjs [--low-memory] [tsconfig ...]
// Naming a tsconfig runs only that program and skips the coverage check.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkExcludedPlugins } from "./link-plugin-dev-sdk.mjs";
import { LOW_MEMORY_VARIABLE, runTsc } from "./run-tsc.mjs";
import { PROJECTS } from "./typecheck-test-projects.mjs";

export const PROVIDER_WORKSPACE = "scripts/typecheck-sandbox-providers";

export const SANDBOX_PROVIDERS = [
  "packages/plugins/sandbox-providers/boxd",
  "packages/plugins/sandbox-providers/cloudflare",
  "packages/plugins/sandbox-providers/cloudflare/bridge-template",
  "packages/plugins/sandbox-providers/createos",
  "packages/plugins/sandbox-providers/daytona",
  "packages/plugins/sandbox-providers/e2b",
  "packages/plugins/sandbox-providers/exe-dev",
  "packages/plugins/sandbox-providers/kubernetes",
  "packages/plugins/sandbox-providers/modal",
  "packages/plugins/sandbox-providers/novita",
];

export const PROGRAMS = [
  "packages/db/tsconfig.test.json",
  "packages/kv-demo-mcp-server/tsconfig.test.json",
  "packages/paperclip-runner/tsconfig.browser.test.json",
  "packages/paperclip-runner/tsconfig.surfaces.test.json",
  "packages/paperclip-runner/tsconfig.test.json",
  "packages/plugins/examples/plugin-orchestration-smoke-example/tsconfig.test.json",
  "packages/plugins/plugin-workspace-diff/tsconfig.test.json",
  "packages/plugins/sdk/tsconfig.test.json",
  ...SANDBOX_PROVIDERS.map((directory) => `${directory}/tsconfig.test.json`),
  "tests/runner-acceptance/tsconfig.json",
  "tests/tsconfig.playwright.json",
];

// server/scripts/typecheck-layers.mjs reads this tree. Everything else must be in a program.
export const CHECKED_ELSEWHERE = ["server/src/"];

const PREPARE_STEPS = [
  ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
  ["--filter", "@paperclipai/paperclip-runner", "run", "ensure:eval-build-deps"],
];
// Replacing a provider's standalone node_modules would otherwise ask for confirmation.
const INSTALL_ARGS = ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline", "--config.confirmModulesPurge=false"];

export function findUncheckedTests({ trackedFiles, checkedFiles, checkedElsewhere = CHECKED_ELSEWHERE }) {
  const checked = new Set(checkedFiles);
  return trackedFiles.filter(
    (file) =>
      /\.(test|spec)\.tsx?$/.test(file) &&
      !checked.has(file) &&
      !checkedElsewhere.some((prefix) => file.startsWith(prefix)),
  );
}

function runPnpm(args, { cwd, env }) {
  const result = spawnSync("pnpm", args, {
    cwd,
    env,
    stdio: "inherit",
    // A bare `pnpm` on Windows is pnpm.cmd, which needs the shell to resolve.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function listProgramFiles(config, { cwd, env }) {
  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    output: result.stdout,
    files: result.stdout
      .split("\n")
      .filter(Boolean)
      .map((file) => path.relative(cwd, file).split(path.sep).join("/")),
  };
}

function listWorkspaceConfigs(root) {
  const result = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Unable to list pnpm workspace packages.");
  return JSON.parse(result.stdout)
    .map((workspace) => path.relative(root, path.join(workspace.path, "tsconfig.json")).split(path.sep).join("/"))
    .filter((config) => config !== "server/tsconfig.json" && existsSync(path.join(root, config)));
}

function listTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Unable to list tracked files.");
  return result.stdout.split("\0").filter(Boolean);
}

/** Returns the test files in no program, or null if a program could not be listed. */
export function checkCoverage({
  root,
  env = process.env,
  programs = PROGRAMS,
  workspaceConfigs = listWorkspaceConfigs,
  trackedFiles = listTrackedFiles,
  listFiles = listProgramFiles,
  logError = console.error,
}) {
  const checkedFiles = [];
  // `pnpm build` and `typecheck:build-gaps` check each workspace's tsconfig.json.
  // scripts/typecheck-test-projects.mjs checks these same files through tsconfig.layers.json.
  const projectConfigs = PROJECTS.map((project) => `${project}/tsconfig.json`);
  for (const config of [...workspaceConfigs(root), ...projectConfigs, ...programs]) {
    const listing = listFiles(config, { cwd: root, env });
    if (listing.status !== 0) {
      logError(`typecheck:test-programs: could not list the files of ${config}\n${listing.output ?? ""}`);
      return null;
    }
    checkedFiles.push(...listing.files);
  }
  return findUncheckedTests({ trackedFiles: trackedFiles(root), checkedFiles });
}

export function typecheckTestPrograms({
  root,
  env = process.env,
  programs = PROGRAMS,
  coverage = true,
  pnpm = runPnpm,
  linkPlugins = linkExcludedPlugins,
  run = runTsc,
  checkFiles = checkCoverage,
  log = console.log,
  logError = console.error,
}) {
  for (const args of PREPARE_STEPS) {
    const status = pnpm(args, { cwd: root, env });
    if (status !== 0) return status;
  }
  const installed = pnpm(INSTALL_ARGS, { cwd: path.join(root, PROVIDER_WORKSPACE), env });
  if (installed !== 0) {
    logError(
      `typecheck:test-programs: if a provider's package.json changed, run ` +
        `\`pnpm install --ignore-scripts --lockfile-only\` in ${PROVIDER_WORKSPACE} and commit its pnpm-lock.yaml`,
    );
    return installed;
  }
  // The install removes the SDK link from each provider's node_modules.
  linkPlugins();

  let exitCode = 0;
  for (const config of programs) {
    log(`typecheck:test-programs: ${config}`);
    const { status, signal } = run(["-p", config], { cwd: root, env });
    if (signal) return status || 1;
    if (status !== 0) exitCode = status;
  }
  if (!coverage) return exitCode;

  const unchecked = checkFiles({ root, env, logError });
  if (unchecked === null) return exitCode || 1;
  if (unchecked.length > 0) {
    logError(
      `typecheck:test-programs: ${unchecked.length} test files are in no typechecked program. ` +
        `Add them to a program in scripts/typecheck-test-programs.mjs. A foo.test.tsx beside a foo.test.ts needs a new name.\n` +
        unchecked.map((file) => `  ${file}`).join("\n"),
    );
    return exitCode || 1;
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const programs = args.filter((arg) => !arg.startsWith("--"));
  const unknownFlags = flags.filter((flag) => flag !== "--low-memory");
  const unknown = programs.filter((program) => !PROGRAMS.includes(program));
  if (unknownFlags.length > 0) {
    console.error(`Unknown option: ${unknownFlags.join(", ")}`);
    process.exitCode = 2;
  } else if (unknown.length > 0) {
    console.error(`Unknown program: ${unknown.join(", ")}. Known programs:\n  ${PROGRAMS.join("\n  ")}`);
    process.exitCode = 2;
  } else {
    process.exitCode = typecheckTestPrograms({
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: flags.includes("--low-memory") ? { ...process.env, [LOW_MEMORY_VARIABLE]: "1" } : process.env,
      programs: programs.length > 0 ? programs : PROGRAMS,
      coverage: programs.length === 0,
    });
  }
}
