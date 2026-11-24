#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { availableParallelism, setPriority } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listLayers } from "../server/scripts/typecheck-layers.mjs";
import { LOW_MEMORY_VARIABLE, EMIT_ONLY_VARIABLE } from "./run-tsc.mjs";
import { selectTestPrograms } from "./typecheck-test-programs.mjs";
import { PROJECTS, selectTestProjects } from "./typecheck-test-projects.mjs";

export const SERIAL_BUILD_GAPS = ["@paperclipai/paperclip-runner"];
export const BACKGROUND_PRIORITY = 10;
export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_TEST_PROGRAMS_CONCURRENCY = 2;
const SERVER_DECLARATIONS = "server declarations";
export const CLI_GUIDANCE_SAFETY = "CLI guidance safety";
const lowMemory = { [LOW_MEMORY_VARIABLE]: "1" };

const GLOBAL_TYPECHECK_INPUTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".npmrc",
  "scripts/run-tsc.mjs",
  "scripts/ci-typecheck-lane.mjs",
  "scripts/typecheck-test-programs.mjs",
  "scripts/typecheck-test-projects.mjs",
  "server/scripts/typecheck-layers.mjs",
]);

const SERVER_UI_INPUTS = [
  "ui/src/lib/",
  "ui/src/api/",
  "ui/src/types/",
  "ui/src/index.css",
  "ui/src/bootstrapSetup.ts",
  "ui/src/pages/CompanyExport.tsx",
  "ui/src/components/MarkdownBody.tsx",
];

const hasPrefix = (files, prefixes) =>
  files.some((file) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix)));

export function isGlobalTypecheckInput(file) {
  return GLOBAL_TYPECHECK_INPUTS.has(file) || file.startsWith("patches/");
}

export function shouldRunReleaseRegistryTests(changedFiles) {
  if (!Array.isArray(changedFiles)) return true;
  return changedFiles.some(
    (file) =>
      file.startsWith("scripts/") ||
      file.startsWith(".github/") ||
      file === "package.json" ||
      file.endsWith("/package.json") ||
      file === "pnpm-lock.yaml" ||
      file === "pnpm-workspace.yaml" ||
      file.startsWith("releases/") ||
      file.startsWith("patches/") ||
      file.startsWith("Dockerfile") ||
      file.startsWith("docker/") ||
      file === "turbo.json" ||
      file.startsWith("vitest.config.") ||
      file === "packages/paperclip-runner/acpx-profiles.json" ||
      file === "packages/paperclip-runner/antigravity-distributions.json" ||
      file.startsWith("packages/paperclip-runner/cursor-") ||
      file.startsWith("packages/paperclip-runner/vitest.config.") ||
      file.startsWith("packages/paperclip-runner/scripts/"),
  );
}

export function selectBuildGapPackages(buildGapPackages, changedFiles) {
  if (!Array.isArray(changedFiles)) return [...buildGapPackages];
  if (changedFiles.some(isGlobalTypecheckInput)) return [...buildGapPackages];
  return buildGapPackages.filter((name) => {
    if (name === "@paperclipai/paperclip-runner") {
      return hasPrefix(changedFiles, [
        "packages/paperclip-runner/",
        "packages/paperclip-eval-kernel/",
        "packages/shared/",
        "packages/adapter-utils/",
      ]);
    }
    if (name === "@paperclipai/ui") {
      return hasPrefix(changedFiles, [
        "ui/",
        "packages/shared/",
        "packages/adapter-utils/",
        "packages/adapters/",
        "packages/plugins/sdk/",
        "maps/",
      ]);
    }
    if (name === "paperclipai") {
      return hasPrefix(changedFiles, [
        "cli/",
        "server/",
        "packages/db/",
        "packages/shared/",
        "packages/adapter-utils/",
        "packages/adapters/",
      ]);
    }
    if (name === "@paperclipai/plugin-llm-wiki") {
      return hasPrefix(changedFiles, [
        "packages/plugins/plugin-llm-wiki/",
        "packages/plugins/sdk/",
        "packages/shared/",
      ]);
    }
    if (name === "@paperclipai/plugin-authoring-smoke-example") {
      return hasPrefix(changedFiles, [
        "packages/plugins/examples/plugin-authoring-smoke-example/",
        "packages/plugins/sdk/",
        "packages/shared/",
      ]);
    }
    // Fail closed for any unknown build-gap workspace package.
    return true;
  });
}

export function shouldRunServerTypecheck(changedFiles, selectedProjects = []) {
  if (!Array.isArray(changedFiles)) return true;
  if (selectedProjects.length > 0) return true;
  return changedFiles.some(
    (file) =>
      isGlobalTypecheckInput(file) ||
      file.startsWith("server/") ||
      file.startsWith("packages/") ||
      file.startsWith("cli/") ||
      SERVER_UI_INPUTS.some((prefix) => file === prefix || file.startsWith(prefix)) ||
      /^ui\/[^/]+$/.test(file),
  );
}

function readGitDiff(root, rangeArgs, execGit) {
  const output = execGit(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", ...rangeArgs, "--"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

export function resolveScope({
  root,
  env = process.env,
  base,
  full = false,
  execGit = (args, options) => execFileSync("git", args, options),
} = {}) {
  if (full || env.PAPERCLIP_CI_FULL === "1" || env.PAPERCLIP_CI_FULL === "true") {
    return { mode: "full", changedFiles: null, reason: "PAPERCLIP_CI_FULL" };
  }

  if (env.CI_PLAN) {
    try {
      const plan = JSON.parse(env.CI_PLAN);
      if (
        plan?.mode === "full" ||
        plan?.forceReason === "Full CI requested" ||
        plan?.forceReason === "Missing or invalid diff" ||
        (typeof plan?.forceReason === "string" && plan.forceReason.startsWith("Diff unavailable:"))
      ) {
        return { mode: "full", changedFiles: null, reason: plan.forceReason || "CI_PLAN mode=full" };
      }
      if (Array.isArray(plan?.changed) && plan.changed.length > 0) {
        return { mode: "pr", changedFiles: plan.changed, reason: "CI_PLAN" };
      }
      return { mode: "full", changedFiles: null, reason: "CI_PLAN had no changed files" };
    } catch {
      return { mode: "full", changedFiles: null, reason: "invalid CI_PLAN" };
    }
  }

  const baseSha = base || env.PAPERCLIP_CI_BASE_SHA;
  if (!baseSha && env.GITHUB_EVENT_NAME !== "pull_request") {
    return { mode: "full", changedFiles: null, reason: "full default" };
  }

  try {
    if (base) {
      const changedFiles = readGitDiff(root, [`${base}...HEAD`], execGit);
      if (changedFiles.length > 0) return { mode: "pr", changedFiles, reason: `git diff ${base}...HEAD` };
      return { mode: "full", changedFiles: null, reason: "empty git diff" };
    }
    let hasMergeSecondParent = false;
    try {
      execGit(["rev-parse", "--verify", "--quiet", "HEAD^2"], { cwd: root, encoding: "utf8" });
      hasMergeSecondParent = true;
    } catch {}
    const rangeArgs = hasMergeSecondParent ? ["HEAD^1", "HEAD"] : [`${baseSha}...HEAD`];
    const changedFiles = readGitDiff(root, rangeArgs, execGit);
    if (changedFiles.length > 0) {
      return { mode: "pr", changedFiles, reason: `git diff ${rangeArgs.join(" ")}` };
    }
    return { mode: "full", changedFiles: null, reason: "empty git diff" };
  } catch {
    return { mode: "full", changedFiles: null, reason: "git diff unavailable" };
  }
}

export function planLane({
  buildGapPackages,
  testLayers,
  projects = PROJECTS,
  changedFiles = null,
  testProgramsConcurrency = DEFAULT_TEST_PROGRAMS_CONCURRENCY,
}) {
  const isPrMode = Array.isArray(changedFiles);
  const selectedBuildGaps = selectBuildGapPackages(buildGapPackages, changedFiles);
  const selectedProjects = selectTestProjects(changedFiles, projects);
  const runServer = shouldRunServerTypecheck(changedFiles, selectedProjects);
  const runReleaseRegistry = shouldRunReleaseRegistryTests(changedFiles);
  const programSelection = selectTestPrograms(changedFiles);

  const typecheckPackage = (name, background) => ({
    name: `typecheck ${name}`,
    command: "pnpm",
    args: ["--filter", name, "typecheck"],
    // UI typecheck runs ~7x faster without --singleThreaded while staying at ~4.4 GiB with GOMAXPROCS=2.
    env: name === "@paperclipai/ui" ? { GOMAXPROCS: "2" } : lowMemory,
    background,
  });

  const prepare = [{ name: "link workspace packages", command: "pnpm", args: ["run", "preflight:workspace-links"] }];

  if (runServer || selectedBuildGaps.length > 0 || programSelection.programs.length > 0) {
    prepare.push({
      name: "build plugin SDK",
      command: "pnpm",
      args: ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
    });
  }

  if (runServer) {
    prepare.push(
      {
        name: "build server without type checks",
        command: "pnpm",
        args: ["--filter", "@paperclipai/server", "build"],
        env: { [EMIT_ONLY_VARIABLE]: "1" },
      },
      {
        name: "check server runtime assets",
        command: "node",
        args: ["scripts/run-typecheck-build-gaps.mjs", "--runtime-assets-only"],
      },
    );
  }

  if (programSelection.includeProviders || programSelection.includeRunnerEval) {
    const prepareArgs = ["scripts/typecheck-test-programs.mjs", "--prepare-only"];
    if (isPrMode) {
      prepareArgs.push("--skip-plugin-sdk");
      if (!programSelection.includeProviders) prepareArgs.push("--no-providers");
      if (!programSelection.includeRunnerEval) prepareArgs.push("--no-runner-eval");
    }
    prepare.push({ name: "install test program dependencies", command: "node", args: prepareArgs });
  }

  prepare.push(
    ...selectedBuildGaps.filter((name) => SERIAL_BUILD_GAPS.includes(name)).map((name) => typecheckPackage(name, false)),
    {
      name: CLI_GUIDANCE_SAFETY,
      command: "pnpm",
      args: ["exec", "vitest", "run", "--project", "@paperclipai/server", "server/src/__tests__/cli-invocation-safety.test.ts"],
    },
  );

  const needsDeclarations = [SERVER_DECLARATIONS];
  const tasks = [];

  if (runServer) {
    tasks.push({
      name: SERVER_DECLARATIONS,
      command: "node",
      args: ["server/scripts/typecheck-layers.mjs", "--declarations-only", "--checkers", "2"],
    });
  }

  if (runReleaseRegistry) {
    tasks.push({ name: "release registry tests", command: "pnpm", args: ["run", "test:release-registry"] });
  }

  if (programSelection.programs.length > 0 || programSelection.checkCoverage) {
    const programArgs = [
      "scripts/typecheck-test-programs.mjs",
      "--skip-prepare",
      "--checkers",
      "1",
      "--concurrency",
      String(testProgramsConcurrency),
    ];
    if (isPrMode) {
      if (!programSelection.includeProviders) programArgs.push("--no-providers");
      if (!programSelection.checkCoverage) {
        programArgs.push("--no-coverage");
      } else if (programSelection.changedTestFiles) {
        for (const file of programSelection.changedTestFiles) programArgs.push("--check-file", file);
      } else {
        programArgs.push("--force-coverage");
      }
      if (programSelection.programs.length === 0) {
        programArgs.push("--coverage-only");
      } else {
        programArgs.push(...programSelection.programs);
      }
    }
    tasks.push({
      name: "typecheck test programs",
      command: "node",
      args: programArgs,
      background: true,
    });
  }

  if (runServer) {
    tasks.push(
      ...testLayers.map((layer) => ({
        name: `server layer ${layer}`,
        command: "node",
        args: ["server/scripts/typecheck-layers.mjs", "--layer", layer, "--checkers", "1"],
        needs: needsDeclarations,
      })),
      ...selectedProjects.map((project) => ({
        name: `test project ${project}`,
        command: "node",
        args: ["scripts/typecheck-test-projects.mjs", "--checkers", "1", "--reuse-declarations", project],
        needs: needsDeclarations,
      })),
    );
  }

  tasks.push(
    ...selectedBuildGaps.filter((name) => !SERIAL_BUILD_GAPS.includes(name)).map((name) => typecheckPackage(name, true)),
  );

  return { prepare, tasks };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

function spawnTask(task, { cwd, env, stdio }) {
  return spawn(task.command, task.args, {
    cwd,
    env: { ...env, ...task.env },
    stdio,
    shell: process.platform === "win32",
  });
}

function runCaptured(task, options) {
  return new Promise((resolve) => {
    const started = Date.now();
    const output = [];
    let child;
    try {
      child = spawnTask(task, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: 1, output: `${error.message}\n`, durationMs: Date.now() - started });
      return;
    }
    if (task.background && child.pid) {
      try {
        setPriority(child.pid, BACKGROUND_PRIORITY);
      } catch {}
    }
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", (error) => output.push(Buffer.from(`${error.message}\n`)));
    child.on("close", (code, signal) => {
      if (signal) output.push(Buffer.from(`${task.name}: terminated by ${signal}\n`));
      resolve({ status: signal ? 1 : (code ?? 1), output: Buffer.concat(output).toString("utf8"), durationMs: Date.now() - started });
    });
  });
}

function runStreamed(task, options) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawnTask(task, { ...options, stdio: "inherit" });
    } catch (error) {
      resolve({ status: 1, output: `${error.message}\n`, durationMs: Date.now() - started });
      return;
    }
    child.on("error", (error) => process.stderr.write(`${error.message}\n`));
    child.on("close", (code, signal) => {
      if (signal) process.stderr.write(`${task.name}: terminated by ${signal}\n`);
      resolve({ status: signal ? 1 : (code ?? 1), durationMs: Date.now() - started });
    });
  });
}

export function createReporter({ write = (text) => process.stdout.write(text), github = Boolean(process.env.GITHUB_ACTIONS) } = {}) {
  const groupStart = (title) => write(github ? `::group::${title}\n` : `\n=== ${title}\n`);
  const groupEnd = () => write(github ? "::endgroup::\n" : "");
  const ensureNewline = (text) => (text.length === 0 || text.endsWith("\n") ? text : `${text}\n`);
  return {
    prepareStart(task) {
      groupStart(`${task.name}: ${task.command} ${task.args.join(" ")}`);
    },
    prepareEnd(task, result) {
      groupEnd();
      write(`${result.status === 0 ? "passed" : "FAILED"}: ${task.name} (${seconds(result.durationMs)})\n`);
    },
    taskEnd(task, result) {
      const title = `${task.name}: ${task.command} ${task.args.join(" ")}`;
      const output = ensureNewline(result.output);
      if (result.status === 0) {
        groupStart(`passed in ${seconds(result.durationMs)}: ${title}`);
        write(output);
        groupEnd();
        return;
      }
      if (github) write(`::error title=Typecheck lane::${task.name} failed with exit code ${result.status}\n`);
      write(`\n=== FAILED in ${seconds(result.durationMs)} with exit code ${result.status}: ${title}\n${output}=== end of ${task.name}\n`);
    },
    taskSkipped(task, missing) {
      write(`skipped: ${task.name}, because ${missing.join(", ")} did not pass\n`);
    },
    summary(rows) {
      const width = Math.max(...rows.map((row) => row.name.length));
      write("\nTypecheck lane summary (start offset, duration, result):\n");
      for (const row of rows) {
        const start = row.startMs === undefined ? "" : seconds(row.startMs);
        const duration = row.durationMs === undefined ? "" : seconds(row.durationMs);
        write(`  ${row.name.padEnd(width)}  ${start.padStart(7)}  ${duration.padStart(7)}  ${row.result}\n`);
      }
    },
  };
}

export async function runLane({
  prepare,
  tasks,
  concurrency,
  cwd = process.cwd(),
  env = process.env,
  runPrepare = runStreamed,
  runTask = runCaptured,
  reporter = createReporter(),
  now = Date.now,
}) {
  const laneStart = now();
  const rows = [];
  for (const task of prepare) {
    reporter.prepareStart(task);
    const startMs = now() - laneStart;
    const result = await runPrepare(task, { cwd, env });
    reporter.prepareEnd(task, result);
    rows.push({ name: task.name, startMs, durationMs: result.durationMs, result: result.status === 0 ? "passed" : "FAILED" });
    if (result.status !== 0) {
      for (const remaining of [...prepare.slice(prepare.indexOf(task) + 1), ...tasks]) {
        rows.push({ name: remaining.name, result: "not run" });
      }
      reporter.summary(rows);
      return result.status || 1;
    }
  }

  const states = new Map(tasks.map((task) => [task.name, "pending"]));
  const results = new Map();
  const running = new Set();
  await new Promise((resolve) => {
    const schedule = () => {
      for (const task of tasks) {
        if (states.get(task.name) !== "pending") continue;
        const needs = task.needs ?? [];
        const missing = needs.filter((name) => ["failed", "skipped"].includes(states.get(name)));
        if (missing.length > 0) {
          states.set(task.name, "skipped");
          reporter.taskSkipped(task, missing);
          continue;
        }
        if (running.size >= concurrency || !needs.every((name) => states.get(name) === "passed")) continue;
        states.set(task.name, "running");
        const startMs = now() - laneStart;
        const promise = runTask(task, { cwd, env }).then((result) => {
          running.delete(promise);
          states.set(task.name, result.status === 0 ? "passed" : "failed");
          results.set(task.name, { ...result, startMs });
          reporter.taskEnd(task, result);
          schedule();
        });
        running.add(promise);
      }
      if (running.size === 0) resolve();
    };
    schedule();
  });

  let exitCode = 0;
  for (const task of tasks) {
    const state = states.get(task.name);
    const result = results.get(task.name);
    if (state !== "passed") exitCode ||= result?.status || 1;
    rows.push({
      name: task.name,
      startMs: result?.startMs,
      durationMs: result?.durationMs,
      result: state === "passed" ? "passed" : state === "failed" ? `FAILED (exit ${result.status})` : "skipped",
    });
  }
  reporter.summary(rows);
  return exitCode;
}

function listBuildGapPackages(root) {
  const result = spawnSync(process.execPath, ["scripts/run-typecheck-build-gaps.mjs", "--list-packages"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let concurrency = Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, availableParallelism()));
  let base;
  let full = false;
  let valid = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--concurrency") {
      concurrency = Number(args[++i]);
      if (!Number.isInteger(concurrency) || concurrency < 1) valid = false;
    } else if (arg === "--base") {
      base = args[++i];
      if (!base || base.startsWith("--")) valid = false;
    } else if (arg === "--full") {
      full = true;
    } else {
      valid = false;
    }
  }
  if (!valid) {
    console.error("Usage: node scripts/ci-typecheck-lane.mjs [--concurrency <n>] [--base <ref>] [--full]");
    process.exitCode = 2;
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const buildGapPackages = listBuildGapPackages(root);
    if (buildGapPackages === null) {
      process.exitCode = 1;
    } else {
      const testLayers = listLayers(path.join(root, "server"))
        .filter((layer) => !layer.emitsDeclarations)
        .map((layer) => layer.name);
      const scope = resolveScope({ root, env: process.env, base, full });
      const scopeDetail =
        scope.mode === "pr"
          ? `PR (${scope.changedFiles.length} changed files via ${scope.reason})`
          : `full (${scope.reason})`;
      const lanePlan = planLane({ buildGapPackages, testLayers, changedFiles: scope.changedFiles });
      console.log(
        `typecheck lane: ${concurrency} at a time; mode: ${scopeDetail}; ` +
          `prepare: ${lanePlan.prepare.length}; tasks: ${lanePlan.tasks.length}; ` +
          `build gaps: ${buildGapPackages.join(", ")}`,
      );
      process.exitCode = await runLane({ ...lanePlan, concurrency, cwd: root });
    }
  }
}
