#!/usr/bin/env node
// Typechecks the test files that no build or package typecheck reads.
//
// Most package tsconfigs exclude tests so that `tsc` does not emit them, and
// Vitest strips types, so a type error in those tests fails nothing. Each program
// in PROGRAMS reads them without emitting. Sandbox providers are outside the
// workspace, so the root install has none of their dependencies. They install from
// typecheck-sandbox-providers/pnpm-lock.yaml here, because their SDK types are part
// of what a test checks. A provider with its own lockfile (LOCKED_PROVIDERS) installs
// from that lockfile instead, so each lockfile has one owner and one Dependabot entry.
//
// The script then fails if a tracked test file is in no program. tsc decides that,
// not a glob: `include` silently drops foo.test.tsx when foo.test.ts exists.
//
// Usage: node scripts/typecheck-test-programs.mjs [--low-memory] [--checkers <n>] [--concurrency <n>] [tsconfig ...]
// Naming a tsconfig runs only that program and skips the coverage check unless --check-file or --force-coverage is given.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkExcludedPlugins } from "./link-plugin-dev-sdk.mjs";
import { emitOnlyTscArgs, lowMemoryTscArgs, LOW_MEMORY_VARIABLE, runTsc } from "./run-tsc.mjs";
import { PROJECTS } from "./typecheck-test-projects.mjs";

export const DEFAULT_CONCURRENCY = 3;
export const PROVIDER_WORKSPACE = "scripts/typecheck-sandbox-providers";

export function defaultConcurrency({ cpus = availableParallelism(), totalMemoryBytes = totalmem() } = {}) {
  const memGiB = totalMemoryBytes / 1024 ** 3;
  if (cpus <= 2 || memGiB < 12) return 1;
  if (cpus <= 4) return 3;
  if (memGiB < 24) return Math.min(4, cpus);
  return Math.min(4, cpus);
}

// Measured CI durations (seconds, run 45440355579 / 45444347449) so concurrent
// execution starts the heaviest programs first instead of leaving 26s tails at the end.
export const PROGRAM_DURATION_WEIGHTS = {
  "tests/tsconfig.playwright.json": 26.3,
  "packages/paperclip-runner/tsconfig.test.json": 25.9,
  "packages/db/tsconfig.test.json": 23.7,
  "packages/paperclip-runner/tsconfig.browser.test.json": 9.6,
  "packages/paperclip-runner/tsconfig.surfaces.test.json": 8.8,
  "packages/plugins/sandbox-providers/daytona/tsconfig.test.json": 7.5,
  "tests/runner-acceptance/tsconfig.json": 7.3,
  "packages/plugins/plugin-workspace-diff/tsconfig.test.json": 7.2,
  "packages/plugins/sdk/tsconfig.test.json": 6.8,
  "packages/plugins/sandbox-providers/kubernetes/tsconfig.test.json": 6.6,
  "packages/plugins/sandbox-providers/e2b/tsconfig.test.json": 5.7,
  "packages/plugins/sandbox-providers/exe-dev/tsconfig.test.json": 5.6,
  "packages/plugins/sandbox-providers/modal/tsconfig.test.json": 4.4,
  "packages/plugins/sandbox-providers/createos/tsconfig.test.json": 4.2,
  "packages/plugins/sandbox-providers/novita/tsconfig.test.json": 3.9,
  "packages/plugins/sandbox-providers/cloudflare/tsconfig.test.json": 3.8,
  "packages/plugins/sandbox-providers/boxd/tsconfig.test.json": 3.7,
  "packages/plugins/examples/plugin-orchestration-smoke-example/tsconfig.test.json": 1.6,
  "packages/kv-demo-mcp-server/tsconfig.test.json": 1.5,
  "scripts/scale-ramp/tsconfig.json": 0.4,
  "packages/plugins/sandbox-providers/cloudflare/bridge-template/tsconfig.test.json": 0.4,
};

export function orderProgramsLpt(programs = PROGRAMS) {
  return [...programs].sort(
    (left, right) => (PROGRAM_DURATION_WEIGHTS[right] ?? 5) - (PROGRAM_DURATION_WEIGHTS[left] ?? 5),
  );
}

export const SANDBOX_PROVIDERS = [
  "packages/plugins/sandbox-providers/boxd",
  "packages/plugins/sandbox-providers/cloudflare",
  "packages/plugins/sandbox-providers/cloudflare/bridge-template",
  "packages/plugins/sandbox-providers/createos",
  "packages/plugins/sandbox-providers/daytona",
  "packages/plugins/sandbox-providers/e2b",
  "packages/plugins/sandbox-providers/exe-dev",
  "packages/plugins/sandbox-providers/kosa8",
  "packages/plugins/sandbox-providers/kubernetes",
  "packages/plugins/sandbox-providers/modal",
  "packages/plugins/sandbox-providers/novita",
];

// Providers that commit their own pnpm-lock.yaml. The release build and the Daytona
// end-to-end job install it frozen, so the shared workspace leaves them out.
export const LOCKED_PROVIDERS = ["packages/plugins/sandbox-providers/daytona"];

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
  "scripts/scale-ramp/tsconfig.json",
  "tests/runner-acceptance/tsconfig.json",
  "tests/tsconfig.playwright.json",
];

// server/scripts/typecheck-layers.mjs reads this tree. Everything else must be in a program.
export const CHECKED_ELSEWHERE = ["server/src/"];

export const SANDBOX_PROVIDER_PROGRAMS = SANDBOX_PROVIDERS.map((directory) => `${directory}/tsconfig.test.json`);

const GLOBAL_PROGRAM_INPUTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".npmrc",
  "scripts/run-tsc.mjs",
  "scripts/ci-typecheck-lane.mjs",
  "scripts/typecheck-test-programs.mjs",
  "scripts/typecheck-test-projects.mjs",
]);

const PLAYWRIGHT_TEST_PREFIXES = [
  "tests/tsconfig.playwright.json",
  "tests/ai-connections-app/",
  "tests/ai-connections-review/",
  "tests/canary-onboarding/",
  "tests/hiring-ai-connections/",
  "tests/html-preview/",
  "tests/perf/",
  "tests/release-smoke/",
  "tests/storybook-visual/",
  "ui/src/",
];

const hasPrefix = (files, prefixes) =>
  files.some((file) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix)));

/**
 * Selects the test programs, preparation needs, and coverage scope affected by `changedFiles` in PR mode.
 * Returns full coverage when `changedFiles` is null/undefined or touches global typecheck inputs.
 */
export function selectTestPrograms(changedFiles, programs = PROGRAMS) {
  if (!Array.isArray(changedFiles)) {
    return {
      programs: [...programs],
      includeProviders: true,
      includeRunnerEval: true,
      checkCoverage: true,
      changedTestFiles: null,
    };
  }
  if (changedFiles.some((file) => GLOBAL_PROGRAM_INPUTS.has(file) || file.startsWith("patches/"))) {
    return {
      programs: [...programs],
      includeProviders: true,
      includeRunnerEval: true,
      checkCoverage: true,
      changedTestFiles: null,
    };
  }

  const sharedChanged = hasPrefix(changedFiles, ["packages/shared/"]);
  const sdkOrSharedChanged =
    sharedChanged ||
    hasPrefix(changedFiles, [
      "packages/plugins/sdk/",
      "scripts/typecheck-sandbox-providers/",
      "scripts/link-plugin-dev-sdk.mjs",
    ]);
  const runnerChanged = hasPrefix(changedFiles, [
    "packages/paperclip-runner/",
    "packages/paperclip-eval-kernel/",
    "packages/adapter-utils/",
  ]);
  const cloudflareChanged = hasPrefix(changedFiles, ["packages/plugins/sandbox-providers/cloudflare/"]);

  const selected = programs.filter((program) => {
    if (program === "packages/db/tsconfig.test.json") {
      return sharedChanged || hasPrefix(changedFiles, ["packages/db/"]);
    }
    if (program === "packages/kv-demo-mcp-server/tsconfig.test.json") {
      return sdkOrSharedChanged || hasPrefix(changedFiles, ["packages/kv-demo-mcp-server/"]);
    }
    if (program.startsWith("packages/paperclip-runner/")) {
      return sharedChanged || runnerChanged;
    }
    if (program === "packages/plugins/examples/plugin-orchestration-smoke-example/tsconfig.test.json") {
      return sdkOrSharedChanged || hasPrefix(changedFiles, ["packages/plugins/examples/plugin-orchestration-smoke-example/"]);
    }
    if (program === "packages/plugins/plugin-workspace-diff/tsconfig.test.json") {
      return sdkOrSharedChanged || hasPrefix(changedFiles, ["packages/plugins/plugin-workspace-diff/"]);
    }
    if (program === "packages/plugins/sdk/tsconfig.test.json") {
      return sdkOrSharedChanged;
    }
    if (program.startsWith("packages/plugins/sandbox-providers/")) {
      if (sdkOrSharedChanged) return true;
      const directory = path.posix.dirname(program);
      if (directory.startsWith("packages/plugins/sandbox-providers/cloudflare")) return cloudflareChanged;
      return hasPrefix(changedFiles, [`${directory}/`]);
    }
    if (program === "scripts/scale-ramp/tsconfig.json") {
      return hasPrefix(changedFiles, ["scripts/scale-ramp/", "scripts/scale-agents-ramp.ts"]);
    }
    if (program === "tests/runner-acceptance/tsconfig.json") {
      return sharedChanged || runnerChanged || hasPrefix(changedFiles, ["tests/runner-acceptance/"]);
    }
    if (program === "tests/tsconfig.playwright.json") {
      return sharedChanged || hasPrefix(changedFiles, PLAYWRIGHT_TEST_PREFIXES);
    }
    // Fail closed for any newly added program without an explicit rule.
    return true;
  });

  const providerSet = new Set(SANDBOX_PROVIDER_PROGRAMS);
  const includeProviders = selected.some((program) => providerSet.has(program));
  const includeRunnerEval = selected.some((program) => program.startsWith("packages/paperclip-runner/"));
  const changedTestFiles = changedFiles.filter(
    (file) => /\.(test|spec)\.tsx?$/.test(file) && !CHECKED_ELSEWHERE.some((prefix) => file.startsWith(prefix)),
  );
  const tsconfigChanged = changedFiles.some((file) => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file));

  return {
    programs: selected,
    includeProviders,
    includeRunnerEval,
    checkCoverage: changedTestFiles.length > 0 || tsconfigChanged,
    changedTestFiles: tsconfigChanged ? null : changedTestFiles.length > 0 ? changedTestFiles : null,
  };
}

const PREPARE_STEPS = [
  ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
  ["--filter", "@paperclipai/paperclip-runner", "run", "ensure:eval-build-deps"],
];
// Replacing a provider's standalone node_modules would otherwise ask for confirmation.
const INSTALL_ARGS = ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline", "--config.confirmModulesPurge=false"];
const LOCKED_INSTALL_ARGS = ["install", "--ignore-workspace", ...INSTALL_ARGS.slice(1)];
// Contributors do not commit provider lockfiles: the lockfile refresh workflow regenerates them after
// merge, as it does the root pnpm-lock.yaml. Until then a changed manifest leaves the lockfile stale,
// so resolve it in place, like the root install in CI.
export const RESOLVE_ARGS = ["install", "--resolution-only", "--ignore-scripts", "--no-frozen-lockfile"];
const LOCKED_RESOLVE_ARGS = ["install", "--ignore-workspace", ...RESOLVE_ARGS.slice(1)];

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

function listProgramFilesAsync(config, { cwd, env }) {
  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(process.execPath, [tsc, "-p", config, "--listFilesOnly"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({
        status: signal ? 1 : (code ?? 1),
        output,
        files: output
          .split("\n")
          .filter(Boolean)
          .map((file) => path.relative(cwd, file).split(path.sep).join("/")),
      });
    });
  });
}

function runTscAsync(args, { cwd = process.cwd(), env = process.env } = {}) {
  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(process.execPath, [tsc, ...args, ...lowMemoryTscArgs(env), ...emitOnlyTscArgs(env)], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        status: signal ? 1 : (code ?? 1),
        signal,
        output: Buffer.concat(chunks).toString("utf8"),
        durationMs: Date.now() - started,
      });
    });
  });
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

function projectCoverageConfigs(root, projects = PROJECTS) {
  const hasServerDeclarations = existsSync(
    path.join(root, "server", "node_modules", ".cache", "paperclip-typecheck", "tsconfig.declarations.json"),
  );
  return projects.map((project) => {
    const layered = `${project}/tsconfig.layers.json`;
    return hasServerDeclarations && existsSync(path.join(root, layered)) ? layered : `${project}/tsconfig.json`;
  });
}

/** Returns the test files in no program, or null if a program could not be listed. */
export function checkCoverage({
  root,
  env = process.env,
  programs = PROGRAMS,
  projects = PROJECTS,
  workspaceConfigs = listWorkspaceConfigs,
  trackedFiles = listTrackedFiles,
  listFiles = listProgramFiles,
  logError = console.error,
}) {
  const checkedFiles = [];
  // `pnpm build` and `typecheck:build-gaps` check each workspace's tsconfig.json.
  // scripts/typecheck-test-projects.mjs checks these same files through tsconfig.layers.json.
  const projectConfigs = projectCoverageConfigs(root, projects);
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

/**
 * Parallel coverage check. When `onlyFiles` is provided, stops as soon as every
 * tracked target test file is confirmed to belong to a typechecked program.
 */
export async function checkCoverageAsync({
  root,
  env = process.env,
  programs = PROGRAMS,
  projects = PROJECTS,
  includeProviders = true,
  onlyFiles = null,
  concurrency = Math.max(1, Math.min(6, availableParallelism())),
  workspaceConfigs = listWorkspaceConfigs,
  trackedFiles = listTrackedFiles,
  listFilesAsync = listProgramFilesAsync,
  logError = console.error,
}) {
  const tracked = trackedFiles(root);
  const checkedElsewhere = includeProviders
    ? CHECKED_ELSEWHERE
    : [...CHECKED_ELSEWHERE, "packages/plugins/sandbox-providers/"];

  let remaining = null;
  if (Array.isArray(onlyFiles)) {
    const trackedSet = new Set(tracked);
    const candidates = findUncheckedTests({
      trackedFiles: onlyFiles.filter((file) => trackedSet.has(file)),
      checkedFiles: [],
      checkedElsewhere,
    });
    if (candidates.length === 0) return [];
    remaining = new Set(candidates);
  }

  const providerSet = new Set(SANDBOX_PROVIDER_PROGRAMS);
  const coveragePrograms = includeProviders ? programs : programs.filter((program) => !providerSet.has(program));
  const projectConfigs = projectCoverageConfigs(root, projects);
  let configs = [...workspaceConfigs(root), ...projectConfigs, ...coveragePrograms];

  if (remaining) {
    const targets = [...remaining];
    const matchesTargetDir = (config) => {
      const dir = path.posix.dirname(config);
      if (dir === ".") return false;
      return targets.some((file) => file.startsWith(`${dir}/`));
    };
    configs = [
      ...configs.filter((config) => matchesTargetDir(config)),
      ...configs.filter((config) => !matchesTargetDir(config)),
    ];
  }

  const checkedFiles = [];
  const queue = [...configs];
  let failed = false;
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  async function worker() {
    while (!failed && !(remaining && remaining.size === 0)) {
      const config = queue.shift();
      if (!config) return;
      const listing = await listFilesAsync(config, { cwd: root, env });
      if (listing.status !== 0) {
        logError(`typecheck:test-programs: could not list the files of ${config}\n${listing.output ?? ""}`);
        failed = true;
        return;
      }
      if (remaining) {
        for (const file of listing.files) remaining.delete(file);
      } else {
        checkedFiles.push(...listing.files);
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (failed) return null;
  if (remaining) return [...remaining];
  return findUncheckedTests({ trackedFiles: tracked, checkedFiles, checkedElsewhere });
}

export function prepareTestPrograms({
  root,
  env = process.env,
  includeProviders = true,
  includeRunnerEval = true,
  includePluginSdk = true,
  pnpm = runPnpm,
  linkPlugins = linkExcludedPlugins,
  log = console.log,
  logError = console.error,
}) {
  const steps = PREPARE_STEPS.filter((args) => {
    if (!includePluginSdk && args.includes("@paperclipai/plugin-sdk")) return false;
    if (!includeRunnerEval && args.includes("@paperclipai/paperclip-runner")) return false;
    return true;
  });
  for (const args of steps) {
    const status = pnpm(args, { cwd: root, env });
    if (status !== 0) return status;
  }
  if (!includeProviders) return 0;
  const install = (directory, frozenArgs, resolveArgs) => {
    const cwd = path.join(root, directory);
    let status = pnpm(frozenArgs, { cwd, env });
    if (status !== 0) {
      log(
        `typecheck:test-programs: ${directory}/pnpm-lock.yaml does not match its manifests. ` +
          `Resolving it in place. Do not commit it: the lockfile refresh workflow updates it after merge.`,
      );
      status = pnpm(resolveArgs, { cwd, env });
      if (status === 0) status = pnpm(frozenArgs, { cwd, env });
    }
    if (status !== 0) logError(`typecheck:test-programs: could not install the sandbox providers in ${directory}`);
    return status;
  };
  const installed = install(PROVIDER_WORKSPACE, INSTALL_ARGS, RESOLVE_ARGS);
  if (installed !== 0) return installed;
  for (const provider of LOCKED_PROVIDERS) {
    const status = install(provider, LOCKED_INSTALL_ARGS, LOCKED_RESOLVE_ARGS);
    if (status !== 0) return status;
  }
  // The installs remove the SDK link from each provider's node_modules.
  linkPlugins();
  return 0;
}

export function typecheckTestPrograms({
  root,
  env = process.env,
  programs = PROGRAMS,
  coverage = true,
  prepare = true,
  includeProviders = true,
  includeRunnerEval = true,
  includePluginSdk = true,
  checkers,
  pnpm = runPnpm,
  linkPlugins = linkExcludedPlugins,
  run = runTsc,
  checkFiles = checkCoverage,
  log = console.log,
  logError = console.error,
}) {
  if (prepare) {
    const prepared = prepareTestPrograms({
      root,
      env,
      includeProviders,
      includeRunnerEval,
      includePluginSdk,
      pnpm,
      linkPlugins,
      log,
      logError,
    });
    if (prepared !== 0) return prepared;
  }

  const checkerArgs = Number.isInteger(checkers) && checkers >= 1 ? ["--checkers", String(checkers)] : [];
  let exitCode = 0;
  for (const config of programs) {
    log(`typecheck:test-programs: ${config}`);
    const { status, signal } = run(["-p", config, ...checkerArgs], { cwd: root, env });
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

export async function typecheckTestProgramsAsync({
  root,
  env = process.env,
  programs = PROGRAMS,
  coverage = true,
  coverageFiles = null,
  prepare = true,
  includeProviders = true,
  includeRunnerEval = true,
  includePluginSdk = true,
  concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, availableParallelism())),
  checkers,
  pnpm = runPnpm,
  linkPlugins = linkExcludedPlugins,
  runAsync = runTscAsync,
  checkFilesAsync = checkCoverageAsync,
  log = console.log,
  logError = console.error,
}) {
  if (prepare) {
    const prepared = prepareTestPrograms({
      root,
      env,
      includeProviders,
      includeRunnerEval,
      includePluginSdk,
      pnpm,
      linkPlugins,
      log,
      logError,
    });
    if (prepared !== 0) return prepared;
  }

  const checkerArgs = Number.isInteger(checkers) && checkers >= 1 ? ["--checkers", String(checkers)] : [];
  let exitCode = 0;
  let aborted = false;
  const queue = orderProgramsLpt(programs);
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  async function worker() {
    while (!aborted) {
      const config = queue.shift();
      if (!config) return;
      const result = await runAsync(["-p", config, ...checkerArgs], { cwd: root, env });
      const elapsed = typeof result.durationMs === "number" ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : "";
      log(`typecheck:test-programs: ${config}${elapsed}`);
      if (result.output) {
        const trimmed = result.output.endsWith("\n") ? result.output.slice(0, -1) : result.output;
        if (result.status === 0 && !result.signal) log(trimmed);
        else logError(trimmed);
      }
      if (result.signal) {
        aborted = true;
        exitCode ||= result.status || 1;
        return;
      }
      if (result.status !== 0) exitCode = result.status;
    }
  }
  if (programs.length > 0) {
    await Promise.all(Array.from({ length: workerCount }, worker));
  }
  if (aborted) return exitCode || 1;
  if (!coverage) return exitCode;

  const unchecked = await checkFilesAsync({
    root,
    env,
    includeProviders,
    onlyFiles: coverageFiles,
    logError,
  });
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
  let lowMemory = false;
  let prepareOnly = false;
  let skipPrepare = false;
  let includeProviders = true;
  let includeRunnerEval = true;
  let includePluginSdk = true;
  let noCoverage = false;
  let forceCoverage = false;
  let coverageOnly = false;
  let concurrency = defaultConcurrency();
  let checkers;
  const checkFiles = [];
  const programs = [];
  const unknownFlags = [];
  let optionError = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--low-memory") lowMemory = true;
    else if (arg === "--prepare-only") prepareOnly = true;
    else if (arg === "--skip-prepare") skipPrepare = true;
    else if (arg === "--no-providers") includeProviders = false;
    else if (arg === "--no-runner-eval") includeRunnerEval = false;
    else if (arg === "--skip-plugin-sdk") includePluginSdk = false;
    else if (arg === "--no-coverage") noCoverage = true;
    else if (arg === "--force-coverage") forceCoverage = true;
    else if (arg === "--coverage-only") coverageOnly = true;
    else if (arg === "--concurrency") {
      concurrency = Number(args[++i]);
      if (!Number.isInteger(concurrency) || concurrency < 1) optionError = "--concurrency requires a positive integer";
    } else if (arg === "--checkers") {
      checkers = Number(args[++i]);
      if (!Number.isInteger(checkers) || checkers < 1) optionError = "--checkers requires a positive integer";
    } else if (arg === "--check-file") {
      const file = args[++i];
      if (!file || file.startsWith("--")) optionError = "--check-file requires a path";
      else checkFiles.push(file);
    } else if (arg.startsWith("--")) {
      unknownFlags.push(arg);
    } else {
      programs.push(arg);
    }
  }

  const unknown = programs.filter((program) => !PROGRAMS.includes(program));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = lowMemory ? { ...process.env, [LOW_MEMORY_VARIABLE]: "1" } : process.env;

  if (unknownFlags.length > 0) {
    console.error(`Unknown option: ${unknownFlags.join(", ")}`);
    process.exitCode = 2;
  } else if (optionError) {
    console.error(optionError);
    process.exitCode = 2;
  } else if (prepareOnly && (skipPrepare || programs.length > 0)) {
    console.error("--prepare-only takes no programs and cannot be combined with --skip-prepare");
    process.exitCode = 2;
  } else if (unknown.length > 0) {
    console.error(`Unknown program: ${unknown.join(", ")}. Known programs:\n  ${PROGRAMS.join("\n  ")}`);
    process.exitCode = 2;
  } else if (prepareOnly) {
    process.exitCode = prepareTestPrograms({
      root,
      env,
      includeProviders,
      includeRunnerEval,
      includePluginSdk,
    });
  } else {
    const selectedPrograms = coverageOnly ? [] : programs.length > 0 ? programs : PROGRAMS;
    const coverage = !noCoverage && (coverageOnly || forceCoverage || checkFiles.length > 0 || programs.length === 0);
    process.exitCode = await typecheckTestProgramsAsync({
      root,
      env,
      programs: selectedPrograms,
      coverage,
      coverageFiles: checkFiles.length > 0 && !forceCoverage ? checkFiles : null,
      prepare: !skipPrepare,
      includeProviders,
      includeRunnerEval,
      includePluginSdk,
      concurrency,
      checkers,
    });
  }
}
