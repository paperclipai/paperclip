import { LOCAL_SPEED_BUDGETS, type SpeedBudget, type SpeedBudgetAdapter } from "../../server/src/services/native-runtime/native-speed-budgets.js";
import type { ChaosApi } from "./api.js";
import {
  baselineRows, distribution, recoverySamples, runMetrics, runSpans, runWarmth, stampProviderLoadStarts,
  type BaselineEvent, type BaselineFault, type BaselineRun, type Distribution,
} from "./ttft-baseline-stats.js";
import type { StorageFaultReceipt } from "./storage-chaos.js";
import type { AdapterId, EnvironmentKind, FaultReceipt, RunSample } from "./types.js";

type Json = Record<string, unknown>;

export interface WaveSpeedTask { issueId: string | null; adapter: AdapterId; samples: Array<{ runs?: RunSample[] }> }

export interface SpeedRow {
  adapter: string; metric: "time_to_first_activity" | "ttft" | "agent_boot" | "workspace_provision" | "restart_recovery"
    | "restart_recovery_control_plane" | "restart_provider_load"; start: "cold" | "warm" | "restart";
  measured: Distribution; budget: SpeedBudget | null; breaches: Array<"p50" | "p95">;
}

export interface WaveSpeed {
  environment: EnvironmentKind;
  rows: SpeedRow[];
  outageAdjustedSpans: number;
  outageRemovedMs: number;
  storageFaultWindows: number;
  storageFaultRemovedMs: number;
  recoveryWithoutProviderEvent: number;
  /** Recovery samples a later fault interrupted before their next provider event (not graded). */
  recoveryInterruptedByFault: number;
  runBudgetExceeded: number;
  singleRunBreaches: number;
  breaches: number;
  errors: string[];
  /**
   * Every graded (non-restart) run's own timing, so a breach can be attributed after the instance is
   * gone: `bootMs` is Paperclip's share (claim to the provider accepting the turn), `providerFirstActivityMs`
   * the provider's (turn accepted to first visible activity), and `preTurnSteps` the spans before the turn.
   */
  runs?: SpeedRunDetail[];
}

export interface SpeedRunDetail {
  runId: string; adapter: string; start: "cold" | "warm"; firstActivityMs: number | null; bootMs: number | null;
  queueMs: number | null; providerFirstActivityMs: number | null; preTurnSteps: Record<string, number>; breach: boolean;
}

const BUDGET_ADAPTER: Partial<Record<AdapterId, SpeedBudgetAdapter>> = { codex: "codex", claude: "claude", opencode: "opencode" };

export function budgetFor(environment: EnvironmentKind, adapter: string, metric: SpeedRow["metric"],
  start: SpeedRow["start"]): SpeedBudget | null {
  const key = BUDGET_ADAPTER[adapter as AdapterId];
  if (environment !== "local" || !key) return null;
  // Reported without a budget: the full recovery and the provider's session load
  // grow with session size and simultaneous resumes; Paperclip's share is judged.
  if (metric === "ttft" || metric === "workspace_provision" || metric === "restart_recovery" || metric === "restart_provider_load") return null;
  const budgets = LOCAL_SPEED_BUDGETS[key] as unknown as Record<string, Record<"cold" | "warm", SpeedBudget> | SpeedBudget>;
  if (metric === "restart_recovery_control_plane") return budgets.restart_recovery_control_plane as SpeedBudget;
  const byStart = (metric === "time_to_first_activity" ? budgets.time_to_first_activity ?? budgets.ttft : budgets[metric]) as
    Record<"cold" | "warm", SpeedBudget>;
  return byStart[start === "warm" ? "warm" : "cold"];
}

export const MIN_AGGREGATE_SAMPLES = 5;

export function breachesOf(measured: Distribution, budget: SpeedBudget | null): Array<"p50" | "p95"> {
  if (!budget || measured.n < MIN_AGGREGATE_SAMPLES) return [];
  const out: Array<"p50" | "p95"> = [];
  if (measured.p50 !== null && measured.p50 > budget.p50Ms) out.push("p50");
  if (measured.p95 !== null && measured.p95 > budget.p95Ms) out.push("p95");
  return out;
}

/**
 * When the primary server served again after a restart, the anchor of a restart-recovery sample; null when
 * the fault did not restart it. A two-server fault's own `readyAt` comes after the second server stopped
 * (multi-server.ts), which is not a restart of the primary:
 *   MS1  leaves the primary serving: no restart.
 *   MS2  freezes and thaws it: no restart, unless it exited after the thaw and was replaced (its `healthyAt`).
 *   MS3  restarts it (K2): its replacement's `readyAt`, before the second server's tail.
 */
export function primaryRestartReadyAt(fault: FaultReceipt): number | null {
  const multi = fault.multiServer;
  if (!multi) return fault.readyAt;
  if (multi.kind === "MS3") return multi.primaryRestart?.readyAt ?? null;
  if (multi.kind === "MS2" && multi.primaryFreeze?.serverExitedAfterThaw) return fault.healthyAt;
  return null;
}

export function faultRuns(faults: readonly FaultReceipt[], runs: ReadonlyArray<{ id: string; createdAt: number; finishedAt: number | null }>): BaselineFault[] {
  return faults.flatMap(fault => {
    const readyAt = primaryRestartReadyAt(fault);
    return readyAt === null ? [] : [{ kind: fault.kind, readyAt, startedAt: fault.startedAt,
      runIds: runs.filter(run => run.createdAt <= readyAt && (run.finishedAt === null || run.finishedAt >= fault.startedAt))
        .map(run => run.id) }];
  });
}

export interface OutageWindow { startedAt: number; readyAt: number }

/**
 * Time the primary could not serve, removed from run timings. MS1 has none. MS2's is the freeze (to the
 * replacement's health when it exited after the thaw). MS3's ends when the replacement is ready.
 */
export function outageWindows(faults: readonly FaultReceipt[]): OutageWindow[] {
  return faults.flatMap((fault): OutageWindow[] => {
    const multi = fault.multiServer;
    if (!multi) return fault.readyAt === null ? [] : [{ startedAt: fault.startedAt, readyAt: fault.readyAt }];
    if (multi.kind === "MS2") {
      const freeze = multi.primaryFreeze;
      const end = freeze?.serverExitedAfterThaw ? fault.healthyAt : freeze?.thawedAt ?? null;
      return freeze?.frozenAt !== undefined && end !== null && end > freeze.frozenAt ? [{ startedAt: freeze.frozenAt, readyAt: end }] : [];
    }
    // MS3 stops the primary only once the second server is ready; the primary served until then.
    const ready = primaryRestartReadyAt(fault);
    const stopping = multi.secondary?.readyAt ?? fault.startedAt;
    return ready === null || ready <= stopping ? [] : [{ startedAt: stopping, readyAt: ready }];
  });
}

export function storageFaultWindows(receipts: readonly StorageFaultReceipt[], now: number): OutageWindow[] {
  return receipts.flatMap(receipt => {
    const readyAt = receipt.endedAt ?? now;
    return readyAt > receipt.startedAt ? [{ startedAt: receipt.startedAt, readyAt }] : [];
  });
}

export function mergeWindows(windows: readonly OutageWindow[]): OutageWindow[] {
  const merged: OutageWindow[] = [];
  for (const window of [...windows].sort((a, b) => a.startedAt - b.startedAt)) {
    const last = merged.at(-1);
    if (last && window.startedAt <= last.readyAt) last.readyAt = Math.max(last.readyAt, window.readyAt);
    else merged.push({ ...window });
  }
  return merged;
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
  const merged = mergeWindows(windows);
  return at => at - merged.reduce((total, window) =>
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
  outage: { adjusted: number; removedMs: number; windows?: readonly OutageWindow[]; storageWindows?: readonly OutageWindow[];
    storageRemovedMs?: number } = { adjusted: 0, removedMs: 0 }): WaveSpeed {
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
  const storageWindows = outage.storageWindows ?? [];
  const clock = outageFreeClock([...(outage.windows ?? []), ...storageWindows]);
  const restartClock = outageFreeClock(outage.windows ?? []);
  const outageFree = (readyAt: number, ms: number | null) => ms === null ? null : Math.max(0, clock(readyAt + ms) - clock(readyAt));
  let storageRemovedMs = outage.storageRemovedMs ?? 0;
  const samples = recoverySamples(runs, faults).map(sample => {
    if (sample.latencyMs !== null) {
      const end = sample.readyAt + sample.latencyMs;
      storageRemovedMs += (restartClock(end) - restartClock(sample.readyAt)) - (clock(end) - clock(sample.readyAt));
    }
    return sample;
  }).map(sample => sample.latencyMs === null ? sample : {
    ...sample, latencyMs: outageFree(sample.readyAt, sample.latencyMs),
    controlPlaneMs: outageFree(sample.readyAt, sample.controlPlaneMs),
    providerLoadMs: sample.providerLoadMs === null || sample.controlPlaneMs === null ? sample.providerLoadMs
      : Math.max(0, clock(sample.readyAt + sample.controlPlaneMs + sample.providerLoadMs) - clock(sample.readyAt + sample.controlPlaneMs)),
  });
  for (const adapter of [...new Set(samples.map(sample => sample.adapter))].sort()) {
    for (const [metric, pick] of [["restart_recovery", (sample: typeof samples[number]) => sample.latencyMs],
      ["restart_recovery_control_plane", (sample: typeof samples[number]) => sample.controlPlaneMs],
      ["restart_provider_load", (sample: typeof samples[number]) => sample.providerLoadMs]] as const) {
      const measured = distribution(samples.flatMap(sample => {
        const value = sample.adapter === adapter ? pick(sample) : null;
        return value === null ? [] : [value];
      }));
      const budget = budgetFor(environment, adapter, metric, "restart");
      rows.push({ adapter, metric, start: "restart", measured, budget, breaches: breachesOf(measured, budget) });
    }
  }
  const singleRunBreaches = runs.filter(run => run.phase !== "restart" && run.phase !== "verify")
    .filter(run => runOverBudget(environment, run)).length + samples.filter(sample => {
    const budget = budgetFor(environment, sample.adapter, "restart_recovery_control_plane", "restart");
    return !sample.interruptedByFault && sample.controlPlaneMs !== null && budget !== null && sample.controlPlaneMs > budget.p95Ms;
  }).length;
  const breaches = rows.reduce((total, row) => total + row.breaches.length, 0) + singleRunBreaches;
  const details = runs.filter(run => run.phase !== "restart" && run.phase !== "verify").map(run => runDetail(environment, run));
  return { environment, rows, runs: details,
    recoveryWithoutProviderEvent: samples.filter(sample => sample.latencyMs === null && !sample.interruptedByFault).length,
    recoveryInterruptedByFault: samples.filter(sample => sample.interruptedByFault).length,
    runBudgetExceeded, singleRunBreaches, breaches, errors, outageAdjustedSpans: outage.adjusted, outageRemovedMs: outage.removedMs,
    storageFaultWindows: storageWindows.length, storageFaultRemovedMs: storageRemovedMs };
}

/** One cold or warm run over its own p95 budget (first activity or boot): a single-run breach. */
function runOverBudget(environment: EnvironmentKind, run: BaselineRun): boolean {
  const start = runWarmth(run);
  const activity = firstActivityMs(run), boot = bootWithoutProvisionMs(run);
  const activityBudget = budgetFor(environment, run.adapter, "time_to_first_activity", start);
  const bootBudget = budgetFor(environment, run.adapter, "agent_boot", start);
  return (activity !== null && activityBudget !== null && activity > activityBudget.p95Ms)
    || (boot !== null && bootBudget !== null && boot > bootBudget.p95Ms);
}

function runDetail(environment: EnvironmentKind, run: BaselineRun): SpeedRunDetail {
  const start = runWarmth(run);
  const metrics = runMetrics(run);
  const spans = runSpans(run);
  const queue = spans.find(span => span.name === "heartbeat.queue") ?? null;
  const submitted = spans.find(span => span.name === "runner.turn.submit") ?? spans.find(span => span.name === "runner.session.resume") ?? null;
  const activity = spans.find(span => span.name === "task.time_to_first_agent_activity") ?? null;
  const turnAt = submitted ? submitted.startOffsetMs + submitted.durationMs : null;
  const activityAt = activity ? activity.startOffsetMs + activity.durationMs : null;
  return { runId: run.runId, adapter: run.adapter, start, firstActivityMs: firstActivityMs(run), bootMs: bootWithoutProvisionMs(run), queueMs: queue?.durationMs ?? null,
    providerFirstActivityMs: turnAt !== null && activityAt !== null ? Math.max(0, activityAt - turnAt) : null,
    preTurnSteps: metrics.preTurnSteps,
    breach: runOverBudget(environment, run) };
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
    const next = Number(page[page.length - 1]!.seq);
    if (!Number.isFinite(next) || next <= afterSeq) throw new Error(`run events page after seq ${afterSeq} has no later seq`);
    afterSeq = next;
  }
}

export async function collectWaveSpeed(api: ChaosApi, environment: EnvironmentKind, tasks: readonly WaveSpeedTask[],
  faults: readonly FaultReceipt[], storageReceipts: readonly StorageFaultReceipt[] = [], now = Date.now()): Promise<WaveSpeed> {
  const runs: BaselineRun[] = [];
  const timing: Array<{ id: string; createdAt: number; finishedAt: number | null }> = [];
  const errors: string[] = [];
  const windows = outageWindows(faults);
  // A freeze is downtime to remove, but only a restart makes a run a restart-phase run: a frozen-then-thawed
  // primary (MS2) keeps its runs in their cold or warm budgets, with the freeze removed.
  const restartWindows = outageWindows(faults.filter(fault => !fault.multiServer || primaryRestartReadyAt(fault) !== null));
  const storageWindows = storageFaultWindows(storageReceipts, now);
  const outage = { adjusted: 0, removedMs: 0, windows, storageWindows, storageRemovedMs: 0 };
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
        if (faultBeforeFirstActivity(raw, restartWindows, Date.parse(run.createdAt!))) raw.phase = "restart";
        // Stamp provider load starts from raw offsets before outage removal rewrites them.
        const stamped = stampProviderLoadStarts(raw);
        const restartOnly = withoutOutage(stamped, windows);
        const trimmed = withoutOutage(stamped, [...windows, ...storageWindows]);
        outage.adjusted += restartOnly.adjusted; outage.removedMs += restartOnly.removedMs;
        outage.storageRemovedMs += trimmed.removedMs - restartOnly.removedMs;
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

function breachCell(row: SpeedRow): string {
  if (row.breaches.length) return row.breaches.join(", ");
  return row.budget && row.measured.n > 0 && row.measured.n < MIN_AGGREGATE_SAMPLES ? `insufficient sample (n < ${MIN_AGGREGATE_SAMPLES})` : "—";
}

export function speedMarkdown(speed: WaveSpeed): string {
  const s = (value: number | null) => value === null ? "—" : `${(value / 1000).toFixed(1)} s`;
  const lines = [`## Speed (${speed.environment})`, "",
    `Breaches: ${speed.breaches} (aggregate p50/p95 rows with at least ${MIN_AGGREGATE_SAMPLES} samples plus ${speed.singleRunBreaches} runs or restart recoveries over the p95 budget after outage removal; the server logged ${speed.runBudgetExceeded} budget_exceeded events before removal).`,
    `Restart samples with no provider event after ready: ${speed.recoveryWithoutProviderEvent}. Interrupted by a later fault (not graded): ${speed.recoveryInterruptedByFault}.`,
    `Outage time removed from ${speed.outageAdjustedSpans} spans: ${s(speed.outageRemovedMs)} (fault start to server ready; budgets judge the rest).`,
    ...(speed.storageFaultWindows ? [`Storage fault time removed: ${s(speed.storageFaultRemovedMs)} across ${speed.storageFaultWindows} windows (storage fault start to end, from storage-faults.json; overlap with restart outage counted once).`] : []), "",
    "| Adapter | Metric | Start | n | p50 | p95 | Budget p50 / p95 | Breach |", "|---|---|---|---|---|---|---|---|"];
  for (const row of speed.rows) {
    lines.push(`| ${row.adapter} | ${row.metric} | ${row.start} | ${row.measured.n} | ${s(row.measured.p50)} | ${s(row.measured.p95)} | `
      + `${row.budget ? `${s(row.budget.p50Ms)} / ${s(row.budget.p95Ms)}` : "no budget"} | ${breachCell(row)} |`);
  }
  if (speed.errors.length) lines.push("", `Speed grade incomplete: ${speed.errors.length} run logs not read; the wave fails.`);
  return `${lines.join("\n")}\n`;
}
