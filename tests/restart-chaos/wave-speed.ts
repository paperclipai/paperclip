import { LOCAL_SPEED_BUDGETS, type SpeedBudget, type SpeedBudgetAdapter } from "../../server/src/services/native-runtime/native-speed-budgets.js";
import type { ChaosApi } from "./api.js";
import {
  baselineRows, distribution, recoverySamples, runMetrics, runSpans, runWarmth,
  type BaselineEvent, type BaselineFault, type BaselineRun, type Distribution,
} from "./ttft-baseline-stats.js";
import type { AdapterId, EnvironmentKind, FaultReceipt, RunSample } from "./types.js";

type Json = Record<string, unknown>;

export interface WaveSpeedTask { issueId: string | null; adapter: AdapterId; samples: Array<{ runs?: RunSample[] }> }

export interface SpeedRow {
  adapter: string; metric: "time_to_first_activity" | "ttft" | "agent_boot" | "workspace_provision" | "restart_recovery"; start: "cold" | "warm" | "restart";
  measured: Distribution; budget: SpeedBudget | null; breaches: Array<"p50" | "p95">;
}

export interface WaveSpeed {
  environment: EnvironmentKind;
  rows: SpeedRow[];
  outageAdjustedSpans: number;
  outageRemovedMs: number;
  recoveryWithoutProviderEvent: number;
  runBudgetExceeded: number;
  singleRunBreaches: number;
  breaches: number;
  errors: string[];
}

const BUDGET_ADAPTER: Partial<Record<AdapterId, SpeedBudgetAdapter>> = { codex: "codex", claude: "claude", opencode: "opencode" };

export function budgetFor(environment: EnvironmentKind, adapter: string, metric: SpeedRow["metric"],
  start: SpeedRow["start"]): SpeedBudget | null {
  const key = BUDGET_ADAPTER[adapter as AdapterId];
  if (environment !== "local" || !key) return null;
  if (metric === "ttft" || metric === "workspace_provision") return null;
  const budgets = LOCAL_SPEED_BUDGETS[key] as unknown as Record<string, Record<"cold" | "warm", SpeedBudget> | SpeedBudget>;
  if (metric === "restart_recovery") return budgets.restart_recovery as SpeedBudget;
  const byStart = (metric === "time_to_first_activity" ? budgets.time_to_first_activity ?? budgets.ttft : budgets[metric]) as
    Record<"cold" | "warm", SpeedBudget>;
  return byStart[start === "warm" ? "warm" : "cold"];
}

export function breachesOf(measured: Distribution, budget: SpeedBudget | null): Array<"p50" | "p95"> {
  if (!budget) return [];
  const out: Array<"p50" | "p95"> = [];
  if (measured.p50 !== null && measured.p50 > budget.p50Ms) out.push("p50");
  if (measured.p95 !== null && measured.p95 > budget.p95Ms) out.push("p95");
  return out;
}

export function faultRuns(faults: readonly FaultReceipt[], runs: ReadonlyArray<{ id: string; createdAt: number; finishedAt: number | null }>): BaselineFault[] {
  return faults.filter(fault => fault.readyAt !== null).map(fault => ({ kind: fault.kind, readyAt: fault.readyAt!,
    runIds: runs.filter(run => run.createdAt <= fault.readyAt! && (run.finishedAt === null || run.finishedAt >= fault.startedAt))
      .map(run => run.id) }));
}

export interface OutageWindow { startedAt: number; readyAt: number }

export function outageWindows(faults: readonly FaultReceipt[]): OutageWindow[] {
  return faults.filter(fault => fault.readyAt !== null).map(fault => ({ startedAt: fault.startedAt, readyAt: fault.readyAt! }));
}

export function traceStartMs(run: BaselineRun): number | null {
  let earliest: number | null = null;
  for (const event of run.events) {
    if (event.eventType !== "run.performance.span" || !event.payload) continue;
    const written = Date.parse(event.createdAt);
    const end = Number(event.payload.startOffsetMs) + Number(event.payload.durationMs);
    if (!Number.isFinite(written) || !Number.isFinite(end)) continue;
    const candidate = written - end;
    if (earliest === null || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

export function outageFreeClock(windows: readonly OutageWindow[]): (at: number) => number {
  return at => at - windows.reduce((total, window) =>
    total + Math.max(0, Math.min(at, window.readyAt) - window.startedAt), 0);
}

export function withoutOutage(run: BaselineRun, windows: readonly OutageWindow[]):
  { run: BaselineRun; adjusted: number; removedMs: number; anchored: boolean } {
  const traceStart = traceStartMs(run);
  if (traceStart === null) return { run, adjusted: 0, removedMs: 0, anchored: false };
  const clock = outageFreeClock(windows);
  const origin = clock(traceStart);
  let adjusted = 0, removedMs = 0;
  const events = run.events.map(event => {
    const payload = event.payload;
    if (event.eventType !== "run.performance.span" || !payload) return event;
    const offset = Number(payload.startOffsetMs), duration = Number(payload.durationMs);
    if (!Number.isFinite(offset) || !Number.isFinite(duration)) return event;
    const start = traceStart + offset, end = start + duration;
    const startOffsetMs = clock(start) - origin, durationMs = clock(end) - clock(start);
    if (startOffsetMs === offset && durationMs === duration) return event;
    if (durationMs !== duration) { adjusted += 1; removedMs += duration - durationMs; }
    return { ...event, payload: { ...payload, startOffsetMs, durationMs } };
  });
  return { run: { ...run, events }, adjusted, removedMs, anchored: true };
}

export function faultBeforeFirstActivity(run: BaselineRun, windows: readonly OutageWindow[], runCreatedAt: number): boolean {
  const traceStart = traceStartMs(run);
  if (traceStart === null) return false;
  const spans = runSpans(run);
  const first = spans.find(span => span.name === "task.time_to_first_agent_activity")
    ?? spans.find(span => span.name === "task.time_to_first_token");
  const end = first ? traceStart + first.startOffsetMs + first.durationMs : Number.POSITIVE_INFINITY;
  return windows.some(window => window.startedAt <= end && window.readyAt >= runCreatedAt);
}

export function firstActivityMs(run: BaselineRun): number | null {
  const metrics = runMetrics(run);
  return metrics.firstActivityAfterRunCreatedMs ?? metrics.ttftAfterRunCreatedMs;
}

export function provisionMs(run: BaselineRun): number | null {
  if (!run.workspaceCreated) return null;
  return runSpans(run).find(span => span.name === "heartbeat.prepare.workspace_provision")?.durationMs ?? null;
}

async function workspaceCreated(api: ChaosApi, runId: string, attempts = 3): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const rows = await api.get<Json[]>(`/api/heartbeat-runs/${runId}/workspace-operations`, 15_000);
      return (rows ?? []).some(row => row.phase === "workspace_provision" && (row.metadata as Json | null)?.created === true);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1_000 * attempt));
    }
  }
  throw new Error(`workspace operations unread: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function bootWithoutProvisionMs(run: BaselineRun): number | null {
  const boot = runMetrics(run).bootMs;
  return boot === null ? null : Math.max(0, boot - (provisionMs(run) ?? 0));
}

function byGroup(runs: readonly BaselineRun[], value: (run: BaselineRun) => number | null): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const run of runs) {
    if (run.phase === "restart" || run.phase === "verify") continue;
    const measured = value(run);
    if (measured === null) continue;
    const key = `${run.adapter}|${runWarmth(run)}`;
    groups.set(key, [...(groups.get(key) ?? []), measured]);
  }
  return groups;
}

function firstActivityByGroup(runs: readonly BaselineRun[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const run of runs) {
    if (run.phase === "restart" || run.phase === "verify") continue;
    const value = firstActivityMs(run);
    if (value === null) continue;
    const key = `${run.adapter}|${runWarmth(run)}`;
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

export function gradeWaveSpeed(environment: EnvironmentKind, runs: readonly BaselineRun[], faults: readonly BaselineFault[],
  runBudgetExceeded: number, errors: string[] = [],
  outage: { adjusted: number; removedMs: number; windows?: readonly OutageWindow[] } = { adjusted: 0, removedMs: 0 }): WaveSpeed {
  const rows: SpeedRow[] = [];
  const activity = firstActivityByGroup(runs);
  const boots = byGroup(runs, bootWithoutProvisionMs), provisions = byGroup(runs, provisionMs);
  for (const row of baselineRows(runs)) {
    const key = `${row.adapter}|${row.warmth}`;
    const firstActivity = activity.get(key) ?? [];
    for (const [metric, measured] of [["time_to_first_activity", distribution(firstActivity)], ["ttft", row.ttftAfterRunCreated],
      ["agent_boot", distribution(boots.get(key) ?? [])], ["workspace_provision", distribution(provisions.get(key) ?? [])]] as const) {
      if (metric === "workspace_provision" && !measured.n) continue;
      const budget = budgetFor(environment, row.adapter, metric, row.warmth);
      rows.push({ adapter: row.adapter, metric, start: row.warmth, measured, budget, breaches: breachesOf(measured, budget) });
    }
  }
  const clock = outageFreeClock(outage.windows ?? []);
  const samples = recoverySamples(runs, faults).map(sample => sample.latencyMs === null ? sample
    : { ...sample, latencyMs: Math.max(0, clock(sample.readyAt + sample.latencyMs) - clock(sample.readyAt)) });
  for (const adapter of [...new Set(samples.map(sample => sample.adapter))].sort()) {
    const measured = distribution(samples.flatMap(sample => sample.adapter === adapter && sample.latencyMs !== null ? [sample.latencyMs] : []));
    const budget = budgetFor(environment, adapter, "restart_recovery", "restart");
    rows.push({ adapter, metric: "restart_recovery", start: "restart", measured, budget, breaches: breachesOf(measured, budget) });
  }
  const singleRunBreaches = runs.filter(run => run.phase !== "restart" && run.phase !== "verify").filter(run => {
    const start = runWarmth(run);
    const activity = firstActivityMs(run), boot = bootWithoutProvisionMs(run);
    const activityBudget = budgetFor(environment, run.adapter, "time_to_first_activity", start);
    const bootBudget = budgetFor(environment, run.adapter, "agent_boot", start);
    return (activity !== null && activityBudget !== null && activity > activityBudget.p95Ms)
      || (boot !== null && bootBudget !== null && boot > bootBudget.p95Ms);
  }).length;
  const breaches = rows.reduce((total, row) => total + row.breaches.length, 0) + singleRunBreaches;
  return { environment, rows, recoveryWithoutProviderEvent: samples.filter(sample => sample.latencyMs === null).length,
    runBudgetExceeded, singleRunBreaches, breaches, errors, outageAdjustedSpans: outage.adjusted, outageRemovedMs: outage.removedMs };
}

async function runEventsWithRetry(api: ChaosApi, runId: string, attempts = 3): Promise<BaselineEvent[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await runEvents(api, runId); } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1_000 * attempt));
    }
  }
  throw lastError;
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

export async function collectWaveSpeed(api: ChaosApi, environment: EnvironmentKind, tasks: readonly WaveSpeedTask[],
  faults: readonly FaultReceipt[]): Promise<WaveSpeed> {
  const runs: BaselineRun[] = [];
  const timing: Array<{ id: string; createdAt: number; finishedAt: number | null }> = [];
  const errors: string[] = [];
  const windows = outageWindows(faults);
  const outage = { adjusted: 0, removedMs: 0, windows };
  const perTask = tasks.map(task => {
    const seen = new Map<string, RunSample>();
    for (const sample of task.samples) for (const run of sample.runs ?? []) if (run.createdAt) seen.set(run.id, run);
    return { task, ordered: [...seen.values()].sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!)) };
  });
  const faultHit = new Set(faultRuns(faults, perTask.flatMap(({ ordered }) => ordered.map(run => ({ id: run.id,
    createdAt: Date.parse(run.createdAt!), finishedAt: run.finishedAt ? Date.parse(run.finishedAt) : null })))).flatMap(fault => fault.runIds));
  for (const { task, ordered } of perTask) {
    for (const [index, run] of ordered.entries()) {
      try {
        const raw: BaselineRun = { runId: run.id, adapter: task.adapter, environment, phase: index === 0 ? "cold" : "warm",
          events: await runEventsWithRetry(api, run.id) };
        try {
          raw.workspaceCreated = await workspaceCreated(api, run.id);
        } catch (error) {
          errors.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (run.retryOfRunId && faultHit.has(run.retryOfRunId)) raw.phase = "restart";
        if (faultBeforeFirstActivity(raw, windows, Date.parse(run.createdAt!))) raw.phase = "restart";
        const trimmed = withoutOutage(raw, windows);
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
    `Breaches: ${speed.breaches} (aggregate p50/p95 rows plus ${speed.singleRunBreaches} runs over the p95 budget after outage removal; the server logged ${speed.runBudgetExceeded} budget_exceeded events before removal).`,
    `Restart samples with no provider event after ready: ${speed.recoveryWithoutProviderEvent}.`,
    `Outage time removed from ${speed.outageAdjustedSpans} spans: ${s(speed.outageRemovedMs)} (fault start to server ready; budgets judge the rest).`, "",
    "| Adapter | Metric | Start | n | p50 | p95 | Budget p50 / p95 | Breach |", "|---|---|---|---|---|---|---|---|"];
  for (const row of speed.rows) {
    lines.push(`| ${row.adapter} | ${row.metric} | ${row.start} | ${row.measured.n} | ${s(row.measured.p50)} | ${s(row.measured.p95)} | `
      + `${row.budget ? `${s(row.budget.p50Ms)} / ${s(row.budget.p95Ms)}` : "no budget"} | ${row.breaches.join(", ") || "—"} |`);
  }
  if (speed.errors.length) lines.push("", `Speed grade incomplete: ${speed.errors.length} run logs not read; the wave fails.`);
  return `${lines.join("\n")}\n`;
}
