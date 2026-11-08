import { LOCAL_SPEED_BUDGETS, type SpeedBudget, type SpeedBudgetAdapter } from "../../server/src/services/native-runtime/native-speed-budgets.js";
import type { ChaosApi } from "./api.js";
import {
  baselineRows, distribution, recoverySamples,
  type BaselineEvent, type BaselineFault, type BaselineRun, type Distribution,
} from "./ttft-baseline-stats.js";
import type { AdapterId, EnvironmentKind, FaultReceipt, RunSample } from "./types.js";

type Json = Record<string, unknown>;

export interface WaveSpeedTask { issueId: string | null; adapter: AdapterId; samples: Array<{ runs?: RunSample[] }> }

export interface SpeedRow {
  adapter: string; metric: "ttft" | "agent_boot" | "restart_recovery"; start: "cold" | "warm" | "restart";
  measured: Distribution; budget: SpeedBudget | null; breaches: Array<"p50" | "p95">;
}

export interface WaveSpeed {
  environment: EnvironmentKind;
  rows: SpeedRow[];
  /** Restart samples with no provider event after the control plane came back. */
  recoveryWithoutProviderEvent: number;
  /** Per-run `run.performance.budget_exceeded` rows (single runs over the p95 budget). */
  runBudgetExceeded: number;
  breaches: number;
  errors: string[];
}

const BUDGET_ADAPTER: Partial<Record<AdapterId, SpeedBudgetAdapter>> = { codex: "codex", claude: "claude", opencode: "opencode" };

export function budgetFor(environment: EnvironmentKind, adapter: string, metric: SpeedRow["metric"],
  start: SpeedRow["start"]): SpeedBudget | null {
  const key = BUDGET_ADAPTER[adapter as AdapterId];
  if (environment !== "local" || !key) return null;
  const budgets = LOCAL_SPEED_BUDGETS[key];
  if (metric === "restart_recovery") return budgets.restart_recovery;
  return budgets[metric][start === "warm" ? "warm" : "cold"];
}

export function breachesOf(measured: Distribution, budget: SpeedBudget | null): Array<"p50" | "p95"> {
  if (!budget) return [];
  const out: Array<"p50" | "p95"> = [];
  if (measured.p50 !== null && measured.p50 > budget.p50Ms) out.push("p50");
  if (measured.p95 !== null && measured.p95 > budget.p95Ms) out.push("p95");
  return out;
}

/** The runs each fault crossed: created before it started and not finished before it. */
export function faultRuns(faults: readonly FaultReceipt[], runs: ReadonlyArray<{ id: string; createdAt: number; finishedAt: number | null }>): BaselineFault[] {
  return faults.filter(fault => fault.readyAt !== null).map(fault => ({ kind: fault.kind, readyAt: fault.readyAt!,
    runIds: runs.filter(run => run.createdAt <= fault.startedAt && (run.finishedAt === null || run.finishedAt >= fault.startedAt))
      .map(run => run.id) }));
}

export function gradeWaveSpeed(environment: EnvironmentKind, runs: readonly BaselineRun[], faults: readonly BaselineFault[],
  runBudgetExceeded: number, errors: string[] = []): WaveSpeed {
  const rows: SpeedRow[] = [];
  for (const row of baselineRows(runs)) {
    for (const [metric, measured] of [["ttft", row.ttftAfterRunCreated], ["agent_boot", row.boot]] as const) {
      const budget = budgetFor(environment, row.adapter, metric, row.warmth);
      rows.push({ adapter: row.adapter, metric, start: row.warmth, measured, budget, breaches: breachesOf(measured, budget) });
    }
  }
  const samples = recoverySamples(runs, faults);
  for (const adapter of [...new Set(samples.map(sample => sample.adapter))].sort()) {
    const measured = distribution(samples.flatMap(sample => sample.adapter === adapter && sample.latencyMs !== null ? [sample.latencyMs] : []));
    const budget = budgetFor(environment, adapter, "restart_recovery", "restart");
    rows.push({ adapter, metric: "restart_recovery", start: "restart", measured, budget, breaches: breachesOf(measured, budget) });
  }
  const breaches = rows.reduce((total, row) => total + row.breaches.length, 0) + runBudgetExceeded;
  return { environment, rows, recoveryWithoutProviderEvent: samples.filter(sample => sample.latencyMs === null).length,
    runBudgetExceeded, breaches, errors };
}

async function runEvents(api: ChaosApi, runId: string): Promise<BaselineEvent[]> {
  const events: BaselineEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await api.get<Json[]>(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=500`, 15_000);
    for (const row of page) events.push({ eventType: String(row.eventType), createdAt: String(row.createdAt), payload: (row.payload ?? null) as Json | null });
    if (page.length < 500) return events;
    afterSeq = Number(page[page.length - 1]!.seq);
  }
}

/** Reads every task run's log through the API and grades it against the speed budgets. */
export async function collectWaveSpeed(api: ChaosApi, environment: EnvironmentKind, tasks: readonly WaveSpeedTask[],
  faults: readonly FaultReceipt[]): Promise<WaveSpeed> {
  const runs: BaselineRun[] = [];
  const timing: Array<{ id: string; createdAt: number; finishedAt: number | null }> = [];
  const errors: string[] = [];
  for (const task of tasks) {
    const seen = new Map<string, RunSample>();
    for (const sample of task.samples) for (const run of sample.runs ?? []) if (run.createdAt) seen.set(run.id, run);
    const ordered = [...seen.values()].sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!));
    for (const [index, run] of ordered.entries()) {
      try {
        runs.push({ runId: run.id, adapter: task.adapter, environment, phase: index === 0 ? "cold" : "warm",
          events: await runEvents(api, run.id) });
        timing.push({ id: run.id, createdAt: Date.parse(run.createdAt!), finishedAt: run.finishedAt ? Date.parse(run.finishedAt) : null });
      } catch (error) {
        errors.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const runBudgetExceeded = runs.reduce((total, run) =>
    total + run.events.filter(event => event.eventType === "run.performance.budget_exceeded").length, 0);
  return gradeWaveSpeed(environment, runs, faultRuns(faults, timing), runBudgetExceeded, errors);
}

export function speedMarkdown(speed: WaveSpeed): string {
  const s = (value: number | null) => value === null ? "—" : `${(value / 1000).toFixed(1)} s`;
  const lines = [`## Speed (${speed.environment})`, "",
    `Breaches: ${speed.breaches} (aggregate p50/p95 rows plus ${speed.runBudgetExceeded} single-run budget_exceeded events).`,
    `Restart samples with no provider event after ready: ${speed.recoveryWithoutProviderEvent}.`, "",
    "| Adapter | Metric | Start | n | p50 | p95 | Budget p50 / p95 | Breach |", "|---|---|---|---|---|---|---|---|"];
  for (const row of speed.rows) {
    lines.push(`| ${row.adapter} | ${row.metric} | ${row.start} | ${row.measured.n} | ${s(row.measured.p50)} | ${s(row.measured.p95)} | `
      + `${row.budget ? `${s(row.budget.p50Ms)} / ${s(row.budget.p95Ms)}` : "no budget"} | ${row.breaches.join(", ") || "—"} |`);
  }
  if (speed.errors.length) lines.push("", `Run logs not read: ${speed.errors.length}.`);
  return `${lines.join("\n")}\n`;
}
