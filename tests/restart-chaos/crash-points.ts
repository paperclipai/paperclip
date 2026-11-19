/**
 * On-demand crash-point suite (durable ownership plan, Phase 5).
 *
 *   pnpm crash-points --list
 *   pnpm crash-points --points 'runner.*' --adapters codex
 *   pnpm crash-points --kinds sandbox_creation_intent --env daytona --daytona-image <image@sha256:…>
 *
 * It runs one restart-chaos wave (main.ts `--crash-point a,b,...`): one
 * isolated control plane boots once, then each selected point in turn gets a
 * batch of tasks (one per adapter × workload), is armed at runtime, SIGKILLs
 * the server at its nth hit, and the server restarts like K1. When the batch
 * rests, plan invariants I1–I8 from the Phase 1 report-only reconciler
 * (invariants.ts) are checked as violations new since the point was armed.
 * Every task is graded R1–R6 at the end.
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
import { knownSecretValues, redactKnownSecrets } from "./evidence.js";
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
  violations: Array<{ rule: string; kind: string; reason: string; recordId: string; evidence?: Record<string, unknown> }>;
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
    "poll-ms": { type: "string" }, keep: { type: "boolean" }, lifecycle: { type: "string" }, "hold-ms": { type: "string" },
    "daytona-reuse-lease": { type: "boolean" },
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
  if (values["hold-ms"] !== undefined) passthrough.push("--crash-point-hold-ms", values["hold-ms"]);
  if (values.keep) passthrough.push("--keep");
  if (values["daytona-reuse-lease"]) passthrough.push("--daytona-reuse-lease");
  return { points: csv(values.points), kinds: csv(values.kinds), adapters, workloads, env, nth, seed, list: values.list === true, passthrough };
}

/** One point's entry in crash-point.json (schema v2). */
export type CrashPointEntry = {
  point: string;
  reached: { name: string; hit: number; pid: number } | null;
  armedAt: number;
  restedAt: number | null;
  tasks: Array<{ taskId: string; adapter: string; workload: string; pass: boolean; signature: string | null; rules: Record<string, string> }>;
  invariants: { violations: Array<{ rule: string; kind: string; reason: string; recordId: string; evidence?: Record<string, unknown> }>; byInvariant: Record<string, number>; errors: string[] } | null;
};

/** Classifies one point from its entry; a point the wave never reached has none. */
export function classifyPoint(point: CrashPointName, exitCode: number | null, entry: CrashPointEntry | null): Omit<PointResult, "waveDir"> {
  const base = { point, exitCode, reached: entry?.reached ?? null, failedInvariants: entry?.invariants?.byInvariant ?? {},
    failedTasks: (entry?.tasks ?? []).filter(task => !task.pass).map(({ pass: _pass, ...task }) => task),
    violations: (entry?.invariants?.violations ?? []).map(({ rule, kind, reason, recordId, evidence }) =>
      ({ rule, kind, reason, recordId, ...(evidence ? { evidence } : {}) })),
    durationMs: entry?.restedAt ? entry.restedAt - entry.armedAt : 0 };
  if (!entry) return { ...base, outcome: "harness_error", error: `not run (wave exited ${exitCode})` };
  if (base.failedTasks.length > 0 || base.violations.length > 0) return { ...base, outcome: "fail" };
  if (entry.invariants?.errors.length) return { ...base, outcome: "harness_error", error: entry.invariants.errors.join("; ") };
  if (!entry.invariants) return { ...base, outcome: "harness_error", error: "no invariant check" };
  if (!entry.reached) {
    const prerequisite = (CRASH_POINTS as Record<string, CrashPointDefinition>)[point]?.prerequisite;
    return { ...base, outcome: "not_reached", ...(prerequisite ? { error: `needs: ${prerequisite}` } : {}) };
  }
  return { ...base, outcome: "pass" };
}

/** One wave for every selected point: one boot, one point at a time. */
async function runSuite(points: readonly CrashPointName[], options: SuiteOptions, runDir: string): Promise<{ results: PointResult[]; exitCode: number | null; waveDir: string | null }> {
  const cells = options.adapters.length * options.workloads.length;
  const args = [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(import.meta.dirname, "main.ts"),
    "--env", options.env, "--adapters", options.adapters.join(","), "--workloads", options.workloads.join(","),
    "--tasks", String(cells * points.length), "--concurrency", String(cells), "--seed", String(options.seed),
    "--crash-point", points.map(point => `${point}:${options.nth}`).join(","), ...options.passthrough];
  console.info(`\n[crash-points] ${points.length} point(s) × ${cells} task(s), results ${runDir}`);
  const exitCode = await new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, stdio: "inherit",
      env: { ...process.env, RESTART_CHAOS_RESULTS_DIR: runDir,
        // The wave boots a fresh instance (all migrations); allow a loaded host.
        RESTART_CHAOS_HEALTH_TIMEOUT_MS: process.env.RESTART_CHAOS_HEALTH_TIMEOUT_MS ?? "600000" } });
    child.once("exit", code => resolve(code));
    child.once("error", () => resolve(null));
  });
  const waves = (await readdir(runDir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && entry.name.startsWith("w-")).map(entry => entry.name).sort();
  const waveDir = waves.length ? path.join(runDir, waves[waves.length - 1]!) : null;
  const filePath = waveDir ? path.join(waveDir, "crash-point.json") : null;
  const file = filePath && existsSync(filePath) ? JSON.parse(await readFile(filePath, "utf8")) as { points?: CrashPointEntry[] } : null;
  const entries = new Map((file?.points ?? []).map(entry => [entry.point.replace(/:\d+$/, ""), entry]));
  return { results: points.map(point => ({ ...classifyPoint(point, exitCode, entries.get(point) ?? null), waveDir })), exitCode, waveDir };
}

export function renderSummary(runId: string, options: SuiteOptions, results: readonly PointResult[]): string {
  const lines = [`# Crash-point suite ${runId}`, "",
    `env ${options.env}, adapters ${options.adapters.join(",")}, workloads ${options.workloads.join(",")}, nth ${options.nth}, seed ${options.seed}`, "",
    "| Point | Outcome | Invariants violated | Failed tasks (rules) | Minutes (armed → rest) |", "|---|---|---|---|---|"];
  for (const result of results) {
    const invariants = Object.entries(result.failedInvariants).map(([id, count]) => `${id}×${count}`).join(", ") || "—";
    const tasks = result.failedTasks.map(task => `${task.taskId} ${task.adapter}/${task.workload} `
      + `(${Object.entries(task.rules).filter(([, verdict]) => verdict === "fail").map(([id]) => id).join(",") || task.signature || "T"})`).join("; ") || "—";
    lines.push(`| \`${result.point}\` | ${result.outcome}${result.error ? ` (${result.error})` : ""} | ${invariants} | ${tasks} | ${(result.durationMs / 60_000).toFixed(1)} |`);
  }
  const violations = results.flatMap(result => result.violations.map(violation => ({ point: result.point, ...violation })));
  if (violations.length) {
    lines.push("", "## Violations", "", "| Point | Rule | Kind | Reason | Record | Evidence |", "|---|---|---|---|---|---|");
    for (const violation of violations) {
      const evidence = violation.evidence ? `\`${JSON.stringify(violation.evidence).replace(/\|/g, "\\|")}\`` : "—";
      lines.push(`| \`${violation.point}\` | ${violation.rule} | ${violation.kind} | ${violation.reason} | ${violation.recordId} | ${evidence} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const options = parseSuiteArgs(process.argv.slice(2));
  const selected = selectPoints(CRASH_POINTS, options);
  if (options.list) {
    for (const name of selected) {
      const definition = CRASH_POINTS[name] as CrashPointDefinition;
      console.info(`${name}\n    ${definition.description}\n    kinds ${definition.kinds.join(", ") || "—"}; invariants ${definition.invariants.join(", ")}; env ${definition.environments.join(", ")}`
        + (definition.prerequisite ? `\n    needs: ${definition.prerequisite}` : ""));
    }
    return 0;
  }
  if (options.env === "daytona") {
    // Fail before a 3-minute boot, not after it.
    const missing = [!process.env.DAYTONA_API_KEY && "DAYTONA_API_KEY",
      !options.passthrough.includes("--daytona-image") && !process.env.PAPERCLIP_E2E_DAYTONA_IMAGE && "--daytona-image (or PAPERCLIP_E2E_DAYTONA_IMAGE)"]
      .filter(Boolean);
    if (missing.length) throw new Error(`--env daytona needs ${missing.join(" and ")}`);
  }
  if (!selected.length) throw new Error(`No crash point matches --points ${options.points.join(",") || "*"} --kinds ${options.kinds.join(",") || "*"} --env ${options.env}`);
  const runId = `cp-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "")}`;
  const runDir = path.join(resultsRoot, "crash-points", runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const { results, exitCode } = await runSuite(selected, options, runDir);
  const summary = renderSummary(runId, options, results)
    + `\nWave exit ${exitCode}; ${((Date.now() - startedAt) / 60_000).toFixed(1)} min in all (one boot, then one point at a time).\n`;
  // Violation evidence carries run and wake error text; CI uploads both files.
  const secrets = knownSecretValues();
  await writeFile(path.join(runDir, "SUMMARY.md"), redactKnownSecrets(summary, secrets), { mode: 0o600 });
  await writeFile(path.join(runDir, "summary.json"),
    `${redactKnownSecrets(JSON.stringify({ runId, options, exitCode, results }, null, 2), secrets)}\n`, { mode: 0o600 });
  console.info(`\n${redactKnownSecrets(summary, secrets)}\nResults: ${runDir}`);
  // Exit 1 with every point clean is a wave-level failure (for example a Daytona leak); see the wave timeline.
  if (exitCode === 2 || exitCode === null) return 2;
  if (results.some(result => result.outcome === "harness_error")) return 2;
  if (results.some(result => result.outcome === "fail") || exitCode === 1) return 1;
  if (results.some(result => result.outcome === "not_reached")) return 3;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await main().catch(error => { console.error(error); return 2; }));
}
