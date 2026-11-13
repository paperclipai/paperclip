#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { availableParallelism, setPriority } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listLayers } from "../server/scripts/typecheck-layers.mjs";
import { LOW_MEMORY_VARIABLE, EMIT_ONLY_VARIABLE } from "./run-tsc.mjs";
import { PROJECTS } from "./typecheck-test-projects.mjs";

export const SERIAL_BUILD_GAPS = ["@paperclipai/paperclip-runner"];
export const BACKGROUND_PRIORITY = 10;
const SERVER_DECLARATIONS = "server declarations";
export const CLI_GUIDANCE_SAFETY = "CLI guidance safety";
const lowMemory = { [LOW_MEMORY_VARIABLE]: "1" };

export function planLane({ buildGapPackages, testLayers, projects = PROJECTS }) {
  const typecheckPackage = (name, background) => ({
    name: `typecheck ${name}`,
    command: "pnpm",
    args: ["--filter", name, "typecheck"],
    env: lowMemory,
    background,
  });
  const prepare = [
    { name: "link workspace packages", command: "pnpm", args: ["run", "preflight:workspace-links"] },
    { name: "build plugin SDK", command: "pnpm", args: ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"] },
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
    { name: "install test program dependencies", command: "node", args: ["scripts/typecheck-test-programs.mjs", "--prepare-only"] },
    ...buildGapPackages.filter((name) => SERIAL_BUILD_GAPS.includes(name)).map((name) => typecheckPackage(name, false)),
    {
      name: CLI_GUIDANCE_SAFETY,
      command: "pnpm",
      args: ["exec", "vitest", "run", "--project", "@paperclipai/server", "server/src/__tests__/cli-invocation-safety.test.ts"],
    },
  ];
  const needsDeclarations = [SERVER_DECLARATIONS];
  const tasks = [
    {
      name: SERVER_DECLARATIONS,
      command: "node",
      args: ["server/scripts/typecheck-layers.mjs", "--declarations-only"],
      env: lowMemory,
    },
    { name: "release registry tests", command: "pnpm", args: ["run", "test:release-registry"] },
    {
      name: "typecheck test programs",
      command: "node",
      args: ["scripts/typecheck-test-programs.mjs", "--low-memory", "--skip-prepare"],
      background: true,
    },
    ...testLayers.map((layer) => ({
      name: `server layer ${layer}`,
      command: "node",
      args: ["server/scripts/typecheck-layers.mjs", "--layer", layer],
      env: lowMemory,
      needs: needsDeclarations,
    })),
    ...projects.map((project) => ({
      name: `test project ${project}`,
      command: "node",
      args: ["scripts/typecheck-test-projects.mjs", "--low-memory", "--reuse-declarations", project],
      needs: needsDeclarations,
    })),
    ...buildGapPackages.filter((name) => !SERIAL_BUILD_GAPS.includes(name)).map((name) => typecheckPackage(name, true)),
  ];
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
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrency = concurrencyIndex === -1 ? availableParallelism() : Number(args[concurrencyIndex + 1]);
  const extra = args.filter((_, index) => concurrencyIndex === -1 || (index !== concurrencyIndex && index !== concurrencyIndex + 1));
  if (!Number.isInteger(concurrency) || concurrency < 1 || extra.length > 0) {
    console.error("Usage: node scripts/ci-typecheck-lane.mjs [--concurrency <n>]");
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
      console.log(`typecheck lane: ${concurrency} at a time; build gaps: ${buildGapPackages.join(", ")}`);
      process.exitCode = await runLane({ ...planLane({ buildGapPackages, testLayers }), concurrency, cwd: root });
    }
  }
}
