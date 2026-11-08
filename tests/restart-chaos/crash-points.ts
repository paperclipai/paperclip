/**
 * On-demand crash-point suite (durable ownership plan, Phase 5).
 *
 *   pnpm crash-points --list
 *   pnpm crash-points --points 'runner.*' --adapters codex
 *   pnpm crash-points --kinds sandbox_creation_intent --env daytona --daytona-image <image@sha256:…>
 *
 * For each selected crash point it runs one restart-chaos wave (main.ts
 * `--crash-point`): a fresh isolated control plane armed to SIGKILL itself at
 * that point once every task launched, one task per selected adapter ×
 * workload, a K1-style restart, R1–R6 grading of every task, then plan
 * invariants I1–I8 from the Phase 1 report-only reconciler (invariants.ts).
 * Results: tests/restart-chaos/results/crash-points/<run>/SUMMARY.md.
 *
 * Exit: 0 every reached point passed, 1 a point failed, 2 a harness error,
 * 3 a selected point was never reached by the chosen workloads.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CRASH_POINTS, type CrashPointDefinition, type CrashPointName } from "../../packages/shared/src/crash-point-registry.js";
import { ADAPTER_IDS, WORKLOAD_IDS, type AdapterId, type WorkloadId } from "./types.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resultsRoot = path.resolve(process.env.RESTART_CHAOS_RESULTS_DIR ?? path.join(import.meta.dirname, "results"));

export type PointOutcome = "pass" | "fail" | "not_reached" | "harness_error";

export interface PointResult {
  point: CrashPointName;
  outcome: PointOutcome;
  exitCode: number | null;
  waveDir: string | null;
  reached: { name: string; hit: number; pid: number } | null;
  failedInvariants: Record<string, number>;
  failedTasks: Array<{ taskId: string; adapter: string; workload: string; signature: string | null; rules: Record<string, string> }>;
  violations: Array<{ rule: string; kind: string; reason: string; recordId: string }>;
  durationMs: number;
  error?: string;
}

export interface SuiteOptions {
  points: string[];
  kinds: string[];
  adapters: AdapterId[];
  workloads: WorkloadId[];
  env: "local" | "daytona";
  nth: number;
  seed: number;
  list: boolean;
  passthrough: string[];
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Points matching any `--points` glob and any `--kinds` id, reachable in `env`. */
export function selectPoints(registry: Record<string, CrashPointDefinition>, options: Pick<SuiteOptions, "points" | "kinds" | "env">): CrashPointName[] {
  const globs = options.points.length ? options.points.map(globToRegExp) : [/.*/];
  return (Object.keys(registry) as CrashPointName[]).filter(name => {
    const definition = registry[name]!;
    if (!globs.some(glob => glob.test(name))) return false;
    if (options.kinds.length && !definition.kinds.some(kind => options.kinds.includes(kind))) return false;
    return definition.environments.includes(options.env);
  });
}

function csv(value: string | undefined): string[] {
  return value ? value.split(",").map(part => part.trim()).filter(Boolean) : [];
}

export function parseSuiteArgs(argv: readonly string[]): SuiteOptions {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const { values } = parseArgs({ args, strict: true, options: {
    points: { type: "string" }, kinds: { type: "string" }, adapters: { type: "string" }, workloads: { type: "string" },
    env: { type: "string" }, nth: { type: "string" }, seed: { type: "string" }, list: { type: "boolean" },
    "daytona-image": { type: "string" }, "daytona-cpu": { type: "string" }, "budget-cents": { type: "string" },
    "poll-ms": { type: "string" }, keep: { type: "boolean" }, lifecycle: { type: "string" },
  } });
  const env = values.env ?? "local";
  if (env !== "local" && env !== "daytona") throw new Error("--env must be local or daytona");
  const adapters = csv(values.adapters ?? "codex") as AdapterId[];
  for (const adapter of adapters) if (!ADAPTER_IDS.includes(adapter)) throw new Error(`Unknown adapter "${adapter}"`);
  const workloads = csv(values.workloads ?? "A1") as WorkloadId[];
  for (const workload of workloads) if (!WORKLOAD_IDS.includes(workload)) throw new Error(`Unknown workload "${workload}"`);
  const nth = Number(values.nth ?? "1");
  if (!Number.isInteger(nth) || nth < 1) throw new Error("--nth must be a positive integer");
  const seed = Number(values.seed ?? "1");
  if (!Number.isInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
  const passthrough: string[] = [];
  for (const key of ["daytona-image", "daytona-cpu", "budget-cents", "poll-ms", "lifecycle"] as const) {
    if (values[key] !== undefined) passthrough.push(`--${key}`, values[key]!);
  }
  if (values.keep) passthrough.push("--keep");
  return { points: csv(values.points), kinds: csv(values.kinds), adapters, workloads, env, nth, seed, list: values.list === true, passthrough };
}

type CrashPointFile = {
  reached: { name: string; hit: number; pid: number } | null;
  tasks: Array<{ taskId: string; adapter: string; workload: string; pass: boolean; signature: string | null; rules: Record<string, string> }>;
  invariants: { violations: Array<{ rule: string; kind: string; reason: string; recordId: string }>; byInvariant: Record<string, number>; errors: string[] } | null;
};

/** Classifies one wave from its exit code and crash-point.json. */
export function classifyWave(point: CrashPointName, exitCode: number | null, file: CrashPointFile | null): Omit<PointResult, "waveDir" | "durationMs"> {
  const base = { point, exitCode, reached: file?.reached ?? null, failedInvariants: file?.invariants?.byInvariant ?? {},
    failedTasks: (file?.tasks ?? []).filter(task => !task.pass).map(({ pass: _pass, ...task }) => task),
    violations: (file?.invariants?.violations ?? []).map(({ rule, kind, reason, recordId }) => ({ rule, kind, reason, recordId })) };
  if (!file || exitCode === 2 || exitCode === null) return { ...base, outcome: "harness_error", error: file ? `wave exited ${exitCode}` : "no crash-point.json" };
  const failed = base.failedTasks.length > 0 || base.violations.length > 0;
  if (failed) return { ...base, outcome: "fail" };
  if (!file.reached) return { ...base, outcome: "not_reached" };
  return { ...base, outcome: "pass" };
}

async function runWave(point: CrashPointName, options: SuiteOptions, runDir: string): Promise<PointResult> {
  const startedAt = Date.now();
  const pointRoot = path.join(runDir, point);
  await mkdir(pointRoot, { recursive: true, mode: 0o700 });
  const tasks = options.adapters.length * options.workloads.length;
  const args = [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(import.meta.dirname, "main.ts"),
    "--env", options.env, "--adapters", options.adapters.join(","), "--workloads", options.workloads.join(","),
    "--tasks", String(tasks), "--concurrency", String(tasks), "--seed", String(options.seed),
    "--crash-point", `${point}:${options.nth}`, ...options.passthrough];
  console.info(`\n[crash-points] ${point}: ${tasks} task(s), results ${pointRoot}`);
  const exitCode = await new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, stdio: "inherit",
      env: { ...process.env, RESTART_CHAOS_RESULTS_DIR: pointRoot,
        // Every wave boots a fresh instance (all migrations); allow a loaded host.
        RESTART_CHAOS_HEALTH_TIMEOUT_MS: process.env.RESTART_CHAOS_HEALTH_TIMEOUT_MS ?? "600000" } });
    child.once("exit", code => resolve(code));
    child.once("error", () => resolve(null));
  });
  const waves = (await readdir(pointRoot, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && entry.name.startsWith("w-")).map(entry => entry.name).sort();
  const waveDir = waves.length ? path.join(pointRoot, waves[waves.length - 1]!) : null;
  const filePath = waveDir ? path.join(waveDir, "crash-point.json") : null;
  const file = filePath && existsSync(filePath) ? JSON.parse(await readFile(filePath, "utf8")) as CrashPointFile : null;
  return { ...classifyWave(point, exitCode, file), waveDir, durationMs: Date.now() - startedAt };
}

export function renderSummary(runId: string, options: SuiteOptions, results: readonly PointResult[]): string {
  const lines = [`# Crash-point suite ${runId}`, "",
    `env ${options.env}, adapters ${options.adapters.join(",")}, workloads ${options.workloads.join(",")}, nth ${options.nth}, seed ${options.seed}`, "",
    "| Point | Outcome | Invariants violated | Failed tasks (rules) | Minutes |", "|---|---|---|---|---|"];
  for (const result of results) {
    const invariants = Object.entries(result.failedInvariants).map(([id, count]) => `${id}×${count}`).join(", ") || "—";
    const tasks = result.failedTasks.map(task => `${task.taskId} ${task.adapter}/${task.workload} `
      + `(${Object.entries(task.rules).filter(([, verdict]) => verdict === "fail").map(([id]) => id).join(",") || task.signature || "T"})`).join("; ") || "—";
    lines.push(`| \`${result.point}\` | ${result.outcome}${result.error ? ` (${result.error})` : ""} | ${invariants} | ${tasks} | ${(result.durationMs / 60_000).toFixed(1)} |`);
  }
  const violations = results.flatMap(result => result.violations.map(violation => ({ point: result.point, ...violation })));
  if (violations.length) {
    lines.push("", "## Violations", "", "| Point | Rule | Kind | Reason | Record |", "|---|---|---|---|---|");
    for (const violation of violations) lines.push(`| \`${violation.point}\` | ${violation.rule} | ${violation.kind} | ${violation.reason} | ${violation.recordId} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const options = parseSuiteArgs(process.argv.slice(2));
  const selected = selectPoints(CRASH_POINTS, options);
  if (options.list) {
    for (const name of selected) {
      const definition = CRASH_POINTS[name] as CrashPointDefinition;
      console.info(`${name}\n    ${definition.description}\n    kinds ${definition.kinds.join(", ") || "—"}; invariants ${definition.invariants.join(", ")}; env ${definition.environments.join(", ")}`);
    }
    return 0;
  }
  if (!selected.length) throw new Error(`No crash point matches --points ${options.points.join(",") || "*"} --kinds ${options.kinds.join(",") || "*"} --env ${options.env}`);
  const runId = `cp-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "")}`;
  const runDir = path.join(resultsRoot, "crash-points", runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const results: PointResult[] = [];
  for (const point of selected) {
    results.push(await runWave(point, options, runDir));
    const summary = renderSummary(runId, options, results);
    await writeFile(path.join(runDir, "SUMMARY.md"), summary, { mode: 0o600 });
    await writeFile(path.join(runDir, "summary.json"), `${JSON.stringify({ runId, options, results }, null, 2)}\n`, { mode: 0o600 });
  }
  console.info(`\n${renderSummary(runId, options, results)}\nResults: ${runDir}`);
  if (results.some(result => result.outcome === "harness_error")) return 2;
  if (results.some(result => result.outcome === "fail")) return 1;
  if (results.some(result => result.outcome === "not_reached")) return 3;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await main().catch(error => { console.error(error); return 2; }));
}
