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
  /** Spans shortened by control-plane outage time (fault start to ready), and the time removed. */
  outageAdjustedSpans: number;
  outageRemovedMs: number;
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

/** A fault's outage: from its start until the replacement server was ready. */
export interface OutageWindow { startedAt: number; readyAt: number }

export function outageWindows(faults: readonly FaultReceipt[]): OutageWindow[] {
  return faults.filter(fault => fault.readyAt !== null).map(fault => ({ startedAt: fault.startedAt, readyAt: fault.readyAt! }));
}

/**
 * The run with every performance span shortened by the outage time inside it,
 * so a held or restarting control plane is never graded as a slow turn.
 * Span offsets are relative to the run's creation.
 */
export function withoutOutage(run: BaselineRun, createdAtMs: number, windows: readonly OutageWindow[]):
  { run: BaselineRun; adjusted: number; removedMs: number } {
  let adjusted = 0, removedMs = 0;
  const events = run.events.map(event => {
    const payload = event.payload;
    if (event.eventType !== "run.performance.span" || !payload) return event;
    const start = createdAtMs + Number(payload.startOffsetMs), duration = Number(payload.durationMs);
    if (!Number.isFinite(start) || !Number.isFinite(duration)) return event;
    const overlap = windows.reduce((total, window) =>
      total + Math.max(0, Math.min(start + duration, window.readyAt) - Math.max(start, window.startedAt)), 0);
    if (overlap <= 0) return event;
    adjusted += 1; removedMs += overlap;
    return { ...event, payload: { ...payload, durationMs: Math.max(0, duration - overlap) } };
  });
  return { run: { ...run, events }, adjusted, removedMs };
}

export function gradeWaveSpeed(environment: EnvironmentKind, runs: readonly BaselineRun[], faults: readonly BaselineFault[],
  runBudgetExceeded: number, errors: string[] = [], outage: { adjusted: number; removedMs: number } = { adjusted: 0, removedMs: 0 }): WaveSpeed {
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
    runBudgetExceeded, breaches, errors, outageAdjustedSpans: outage.adjusted, outageRemovedMs: outage.removedMs };
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
  const windows = outageWindows(faults);
  const outage = { adjusted: 0, removedMs: 0 };
  for (const task of tasks) {
    const seen = new Map<string, RunSample>();
    for (const sample of task.samples) for (const run of sample.runs ?? []) if (run.createdAt) seen.set(run.id, run);
    const ordered = [...seen.values()].sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!));
    for (const [index, run] of ordered.entries()) {
      try {
        const raw: BaselineRun = { runId: run.id, adapter: task.adapter, environment, phase: index === 0 ? "cold" : "warm",
          events: await runEvents(api, run.id) };
        const trimmed = withoutOutage(raw, Date.parse(run.createdAt!), windows);
        outage.adjusted += trimmed.adjusted; outage.removedMs += trimmed.removedMs;
        runs.push(trimmed.run);
        timing.push({ id: run.id, createdAt: Date.parse(run.createdAt!), finishedAt: run.finishedAt ? Date.parse(run.finishedAt) : null });
      } catch (error) {
        errors.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const runBudgetExceeded = runs.reduce((total, run) =>
    total + run.events.filter(event => event.eventType === "run.performance.budget_exceeded").length, 0);
  return gradeWaveSpeed(environment, runs, faultRuns(faults, timing), runBudgetExceeded, errors, outage);
}

export function speedMarkdown(speed: WaveSpeed): string {
  const s = (value: number | null) => value === null ? "—" : `${(value / 1000).toFixed(1)} s`;
  const lines = [`## Speed (${speed.environment})`, "",
    `Breaches: ${speed.breaches} (aggregate p50/p95 rows plus ${speed.runBudgetExceeded} single-run budget_exceeded events).`,
    `Restart samples with no provider event after ready: ${speed.recoveryWithoutProviderEvent}.`,
    `Outage time removed from ${speed.outageAdjustedSpans} spans: ${s(speed.outageRemovedMs)} (fault start to server ready; budgets judge the rest).`, "",
    "| Adapter | Metric | Start | n | p50 | p95 | Budget p50 / p95 | Breach |", "|---|---|---|---|---|---|---|---|"];
  for (const row of speed.rows) {
    lines.push(`| ${row.adapter} | ${row.metric} | ${row.start} | ${row.measured.n} | ${s(row.measured.p50)} | ${s(row.measured.p95)} | `
      + `${row.budget ? `${s(row.budget.p50Ms)} / ${s(row.budget.p95Ms)}` : "no budget"} | ${row.breaches.join(", ") || "—"} |`);
  }
  if (speed.errors.length) lines.push("", `Run logs not read: ${speed.errors.length}.`);
  return `${lines.join("\n")}\n`;
}
