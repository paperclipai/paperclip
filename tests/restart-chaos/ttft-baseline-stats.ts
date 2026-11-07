/**
 * Pure statistics for the Phase 0 time-to-first-token baseline
 * (doc/plans/2026-11-07-ttft-baseline.md). Input is the run log only:
 * `run.performance.span`, `run.startup.reuse` and `native.recovery.transition`
 * rows from `heartbeat_run_events`. Never Telemetry (AGENTS.md §5.7).
 */

export interface BaselineEvent {
  eventType: string;
  createdAt: string;
  payload?: Record<string, unknown> | null;
}

export interface BaselineRun {
  runId: string;
  adapter: string;
  environment: string;
  /** Driver intent: a new task, a follow-up comment on the same task, or a run crossed by a restart. */
  phase: "cold" | "warm" | "restart";
  events: BaselineEvent[];
}

export interface BaselineFault {
  kind: string;
  readyAt: number;
  /** Runs that were in flight when the fault started. */
  runIds: string[];
}

export interface Distribution { n: number; p50: number | null; p95: number | null; max: number | null }

/** Nearest-rank percentile over a finite sample. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

export function distribution(values: readonly number[]): Distribution {
  const finite = values.filter(Number.isFinite);
  return { n: finite.length, p50: percentile(finite, 50), p95: percentile(finite, 95),
    max: finite.length ? Math.max(...finite) : null };
}

export interface RunSpan { name: string; parent: string; startOffsetMs: number; durationMs: number; attributes: Record<string, unknown> }

export function runSpans(run: BaselineRun): RunSpan[] {
  return run.events.filter(event => event.eventType === "run.performance.span" && event.payload)
    .map(event => {
      const payload = event.payload!;
      return { name: String(payload.span), parent: String(payload.parentSpan ?? ""),
        startOffsetMs: Number(payload.startOffsetMs), durationMs: Number(payload.durationMs), attributes: payload };
    })
    .filter(span => Number.isFinite(span.startOffsetMs) && Number.isFinite(span.durationMs));
}

/** cold = fresh provider session; warm = verified reuse. Falls back to the driver phase. */
export function runWarmth(run: BaselineRun): "cold" | "warm" {
  const reuse = run.events.find(event => event.eventType === "run.startup.reuse" && event.payload?.layer === "provider_session");
  if (reuse?.payload?.state === "reused") return "warm";
  if (reuse?.payload?.state === "fresh") return "cold";
  return run.phase === "warm" ? "warm" : "cold";
}

export interface RunMetrics {
  ttftMs: number | null;
  ttftAnchor: string | null;
  /** Run claimed (end of heartbeat.queue) → durable `turn.submitted` (provider session accepted turn.start). */
  bootMs: number | null;
  /** Durations of every span that starts before the first turn submission. */
  preTurnSteps: Record<string, number>;
}

/** Spans that wrap others (or the whole run); ranking them would double count. */
const CUMULATIVE_SPANS = new Set(["task.time_to_first_token", "task.provider_session.measured", "task.prepare",
  "native.session.execute", "runner.session.startup", "agent.turn", "environment.startup"]);

const FIRST_SPAN = (spans: RunSpan[], name: string) => spans.find(span => span.name === name) ?? null;

export function runMetrics(run: BaselineRun): RunMetrics {
  const spans = runSpans(run);
  const ttft = FIRST_SPAN(spans, "task.time_to_first_token");
  const queue = FIRST_SPAN(spans, "heartbeat.queue");
  // runner.turn.submit = session.started → turn.submitted; a resumed session has
  // runner.session.resume ending at turn.submitted instead.
  const submitted = FIRST_SPAN(spans, "runner.turn.submit") ?? FIRST_SPAN(spans, "runner.session.resume");
  const claimedAt = queue ? queue.startOffsetMs + queue.durationMs : null;
  const turnStartAt = submitted ? submitted.startOffsetMs + submitted.durationMs : null;
  const preTurnSteps: Record<string, number> = {};
  if (turnStartAt !== null) {
    for (const span of spans) {
      // Cumulative wrappers overlap their children; keep them out of the ranking.
      if (CUMULATIVE_SPANS.has(span.name)) continue;
      if (span.startOffsetMs < turnStartAt && !(span.name in preTurnSteps)) preTurnSteps[span.name] = span.durationMs;
    }
  }
  return {
    ttftMs: ttft ? ttft.durationMs : null,
    ttftAnchor: ttft && typeof ttft.attributes.anchor === "string" ? ttft.attributes.anchor : null,
    bootMs: claimedAt !== null && turnStartAt !== null ? Math.max(0, turnStartAt - claimedAt) : null,
    preTurnSteps,
  };
}

const PROVIDER_EVENT_TYPES = new Set(["turn.submitted", "turn.started", "turn.accepted", "item.started", "item.delta",
  "item.completed", "tool.execution.started", "tool.execution.progressed", "tool.execution.completed", "session.resumed"]);

export interface RecoverySample { runId: string; adapter: string; kind: string; disposition: string; latencyMs: number | null }

/** Control plane ready → the recovered run's next provider event, keyed by runner disposition. */
export function recoverySamples(runs: readonly BaselineRun[], faults: readonly BaselineFault[]): RecoverySample[] {
  const byId = new Map(runs.map(run => [run.runId, run]));
  const samples: RecoverySample[] = [];
  for (const fault of faults) {
    for (const runId of fault.runIds) {
      const run = byId.get(runId);
      if (!run) continue;
      const after = run.events.filter(event => Date.parse(event.createdAt) >= fault.readyAt - 60_000);
      const transition = after.find(event => event.eventType === "native.recovery.transition"
        && Date.parse(event.createdAt) >= fault.readyAt - 60_000);
      const next = run.events.find(event => PROVIDER_EVENT_TYPES.has(event.eventType) && Date.parse(event.createdAt) >= fault.readyAt);
      samples.push({ runId, adapter: run.adapter, kind: fault.kind,
        disposition: String(transition?.payload?.runnerDisposition ?? "none"),
        latencyMs: next ? Date.parse(next.createdAt) - fault.readyAt : null });
    }
  }
  return samples;
}

export interface BaselineRow { adapter: string; environment: string; warmth: "cold" | "warm"; ttft: Distribution; boot: Distribution; anchors: Record<string, number> }

export function baselineRows(runs: readonly BaselineRun[]): BaselineRow[] {
  const groups = new Map<string, { adapter: string; environment: string; warmth: "cold" | "warm"; metrics: RunMetrics[] }>();
  for (const run of runs) {
    if (run.phase === "restart") continue;
    const warmth = runWarmth(run);
    const key = `${run.adapter}|${run.environment}|${warmth}`;
    const group = groups.get(key) ?? { adapter: run.adapter, environment: run.environment, warmth, metrics: [] };
    group.metrics.push(runMetrics(run));
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => `${a.adapter}${a.warmth}`.localeCompare(`${b.adapter}${b.warmth}`)).map(group => {
    const anchors: Record<string, number> = {};
    for (const metric of group.metrics) if (metric.ttftAnchor) anchors[metric.ttftAnchor] = (anchors[metric.ttftAnchor] ?? 0) + 1;
    return { adapter: group.adapter, environment: group.environment, warmth: group.warmth, anchors,
      ttft: distribution(group.metrics.flatMap(metric => metric.ttftMs === null ? [] : [metric.ttftMs])),
      boot: distribution(group.metrics.flatMap(metric => metric.bootMs === null ? [] : [metric.bootMs])) };
  });
}

export interface StepRank { step: string; n: number; p50: number | null; p95: number | null; adapters: string[] }

/** Pre-turn steps ranked by p95, then p50. Steps under 1 ms at p95 are dropped. */
export function rankPreTurnSteps(runs: readonly BaselineRun[]): StepRank[] {
  const steps = new Map<string, { values: number[]; adapters: Set<string> }>();
  for (const run of runs) {
    for (const [step, value] of Object.entries(runMetrics(run).preTurnSteps)) {
      const entry = steps.get(step) ?? { values: [], adapters: new Set<string>() };
      entry.values.push(value);
      entry.adapters.add(run.adapter);
      steps.set(step, entry);
    }
  }
  return [...steps.entries()].map(([step, entry]) => {
    const d = distribution(entry.values);
    return { step, n: d.n, p50: d.p50, p95: d.p95, adapters: [...entry.adapters].sort() };
  }).filter(rank => (rank.p95 ?? 0) >= 1)
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0) || (b.p50 ?? 0) - (a.p50 ?? 0));
}
