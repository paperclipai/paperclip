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
  phase: "cold" | "warm" | "restart" | "midturn" | "verify";
  events: BaselineEvent[];
  workspaceCreated?: boolean;
}

export interface BaselineFault {
  kind: string;
  readyAt: number;
  /** When the fault began. A recovery that a later fault interrupts before its
   * next provider event is not a measurement of this fault's recovery. */
  startedAt?: number;
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
  /** Input accepted to run created (`comment.to_run_created` or
   * `question_response.to_run_created`): the wait behind a live turn. Part of
   * the user-visible TTFT; reported as its own step, not judged by the budget. */
  inputWaitMs: number | null;
  /** TTFT (first text) from run creation: reported, no budget for tool-first adapters. */
  ttftAfterRunCreatedMs: number | null;
  /** First visible agent activity (text delta, tool-call start or reasoning)
   * from run creation (`task.time_to_first_agent_activity`): what the speed
   * budget judges. */
  firstActivityAfterRunCreatedMs: number | null;
}

/** Spans that wrap others (or the whole run); ranking them would double count. */
const CUMULATIVE_SPANS = new Set(["task.time_to_first_token", "task.time_to_first_agent_activity", "comment.to_run_created", "question_response.to_run_created", "task.provider_session.measured", "task.prepare",
  "native.session.execute", "runner.session.startup", "agent.turn", "environment.startup"]);

const FIRST_SPAN = (spans: RunSpan[], name: string) => spans.find(span => span.name === name) ?? null;

export function runMetrics(run: BaselineRun): RunMetrics {
  const spans = runSpans(run);
  const ttft = FIRST_SPAN(spans, "task.time_to_first_token");
  const activity = FIRST_SPAN(spans, "task.time_to_first_agent_activity");
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
  const ingress = FIRST_SPAN(spans, "comment.to_run_created") ?? FIRST_SPAN(spans, "question_response.to_run_created");
  // Only an ingress that starts the TTFT span waited for its run to exist.
  const anchor = ttft ?? activity;
  // From run creation, as the runtime budget judges it: the start of
  // heartbeat.queue, else the end of the ingress span. Independent of the
  // span's own anchor (an earlier wake request or comment is not counted).
  const runCreatedAt = queue ? queue.startOffsetMs : ingress ? ingress.startOffsetMs + ingress.durationMs : null;
  const afterRunCreated = (span: RunSpan) => runCreatedAt === null
    ? Math.max(0, span.durationMs - (inputWaitMs ?? 0))
    : Math.max(0, span.startOffsetMs + span.durationMs - runCreatedAt);
  const inputWaitMs = ingress && anchor && ingress.startOffsetMs <= anchor.startOffsetMs ? ingress.durationMs : null;
  return {
    inputWaitMs,
    firstActivityAfterRunCreatedMs: activity ? afterRunCreated(activity) : null,
    ttftAfterRunCreatedMs: ttft ? afterRunCreated(ttft) : null,
    ttftMs: ttft ? ttft.durationMs : null,
    ttftAnchor: ttft && typeof ttft.attributes.anchor === "string" ? ttft.attributes.anchor : null,
    bootMs: claimedAt !== null && turnStartAt !== null ? Math.max(0, turnStartAt - claimedAt) : null,
    preTurnSteps,
  };
}

const PROVIDER_EVENT_TYPES = new Set(["turn.submitted", "turn.started", "turn.accepted", "item.started", "item.delta",
  "item.completed", "tool.execution.started", "tool.execution.progressed", "tool.execution.completed", "session.resumed"]);

export interface RecoverySample { runId: string; adapter: string; kind: string; disposition: string; readyAt: number; latencyMs: number | null;
  /** Paperclip's share: ready to the start of the provider's session load (`provider.session.load`), or the whole
   * latency when nothing reloads. The judged row. */
  controlPlaneMs: number | null;
  /** The provider's share: session load start to the next provider event. Reported. */
  providerLoadMs: number | null;
  /** A later fault began before this recovery reached its next provider event
   * (back-to-back faults). Its latencies are null: the later fault's own sample
   * measures that run. */
  interruptedByFault?: true }

/** Control plane ready → the recovered run's next provider event, keyed by runner disposition. */
/** The run's trace start: every span records its offset from it. A span event is
 * written when the span ends, possibly through deferred work, so each one gives
 * an upper bound (write time minus offset and duration); the earliest is used. */
export function spanTraceStartMs(run: BaselineRun): number | null {
  let earliest: number | null = null;
  for (const event of run.events) {
    if (event.eventType !== "run.performance.span" || !event.payload) continue;
    const candidate = Date.parse(event.createdAt) - (Number(event.payload.startOffsetMs) + Number(event.payload.durationMs));
    if (Number.isFinite(candidate) && (earliest === null || candidate < earliest)) earliest = candidate;
  }
  return earliest;
}

/** Stamps each provider session load with its wall-clock start (`wallStartMs`).
 * The server writes the span's own start as `wallStartedAtMs`; runs logged before
 * that field existed fall back to the trace start plus the span's offset, never to
 * its write time. Call on the raw run, before outage removal rewrites offsets. */
export function stampProviderLoadStarts(run: BaselineRun): BaselineRun {
  const anchor = spanTraceStartMs(run);
  return { ...run, events: run.events.map(event => {
    if (event.eventType !== "run.performance.span" || event.payload?.span !== "provider.session.load" || event.payload.wallStartMs !== undefined) return event;
    const logged = Number(event.payload.wallStartedAtMs);
    const offset = Number(event.payload.startOffsetMs);
    const start = Number.isFinite(logged) ? logged : anchor !== null && Number.isFinite(offset) ? anchor + offset : null;
    return start === null ? event : { ...event, payload: { ...event.payload, wallStartMs: start } };
  }) };
}

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
      const nextAt = next ? Date.parse(next.createdAt) : null;
      if (nextAt !== null && faults.some(other => other.startedAt !== undefined && other.startedAt > fault.readyAt && other.startedAt < nextAt)) {
        samples.push({ runId, adapter: run.adapter, kind: fault.kind, readyAt: fault.readyAt,
          disposition: String(transition?.payload?.runnerDisposition ?? "none"),
          latencyMs: null, controlPlaneMs: null, providerLoadMs: null, interruptedByFault: true });
        continue;
      }
      const stamped = stampProviderLoadStarts(run);
      const loadStarts = nextAt === null ? [] : stamped.events.flatMap(event => {
        if (event.eventType !== "run.performance.span" || event.payload?.span !== "provider.session.load") return [];
        const start = Number(event.payload.wallStartMs);
        return Number.isFinite(start) && start >= fault.readyAt && start <= nextAt ? [start] : [];
      });
      const loadStart = loadStarts.length ? Math.min(...loadStarts) : null;
      samples.push({ runId, adapter: run.adapter, kind: fault.kind, readyAt: fault.readyAt,
        disposition: String(transition?.payload?.runnerDisposition ?? "none"),
        latencyMs: nextAt === null ? null : nextAt - fault.readyAt,
        controlPlaneMs: nextAt === null ? null : (loadStart ?? nextAt) - fault.readyAt,
        providerLoadMs: nextAt === null ? null : loadStart === null ? 0 : nextAt - loadStart });
    }
  }
  return samples;
}

export interface BaselineRow { adapter: string; environment: string; warmth: "cold" | "warm"; ttft: Distribution; boot: Distribution;
  /** The wait behind a live turn (input accepted to run created), its own measured step. */
  inputWait: Distribution;
  /** TTFT (first text) from run creation: reported. */
  ttftAfterRunCreated: Distribution;
  /** First visible agent activity from run creation: the value the speed budget judges. */
  firstActivityAfterRunCreated: Distribution;
  anchors: Record<string, number> }

export function baselineRows(runs: readonly BaselineRun[]): BaselineRow[] {
  const groups = new Map<string, { adapter: string; environment: string; warmth: "cold" | "warm"; metrics: RunMetrics[] }>();
  for (const run of runs) {
    // Restart samples and new-agent verification samples are reported on their own.
    if (run.phase === "restart" || run.phase === "verify") continue;
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
      boot: distribution(group.metrics.flatMap(metric => metric.bootMs === null ? [] : [metric.bootMs])),
      inputWait: distribution(group.metrics.flatMap(metric => metric.inputWaitMs === null ? [] : [metric.inputWaitMs])),
      ttftAfterRunCreated: distribution(group.metrics.flatMap(metric => metric.ttftAfterRunCreatedMs === null ? [] : [metric.ttftAfterRunCreatedMs])),
      firstActivityAfterRunCreated: distribution(group.metrics.flatMap(metric => metric.firstActivityAfterRunCreatedMs === null ? [] : [metric.firstActivityAfterRunCreatedMs])) };
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

/** The tool payload of a run-log `tool.execution.*` row (PRP envelope or bare). */
function toolPayload(event: BaselineEvent): Record<string, unknown> {
  const outer = event.payload ?? {};
  const prp = outer.prpEvent as Record<string, unknown> | undefined;
  return ((prp?.payload ?? outer) as Record<string, unknown>) ?? {};
}

const SHELL_TOOL = /\b(bash|sh|zsh|shell|terminal|python3?)\b/i;

export interface OpenShellExecution {
  executionId: string;
  /** The tool exposed command text (name, subject or progress) that contains the marker. */
  matched: boolean;
  /** The tool exposed no command text at all, so the marker cannot be checked. */
  unlabelled: boolean;
}

/**
 * Executions of a shell tool that started and have not ended. A restart sample
 * is valid only while one is open, so the fault lands inside the tool call.
 * With `marker`, an execution is `matched` when its exposed command text
 * contains the marker. Some tools (OpenCode's `bash`) expose no command text;
 * those are `unlabelled`.
 */
export function openShellExecutions(events: readonly BaselineEvent[], marker?: string): OpenShellExecution[] {
  const open = new Map<string, { matched: boolean; labelled: boolean }>();
  for (const event of events) {
    if (!event.eventType.startsWith("tool.execution.")) continue;
    const payload = toolPayload(event);
    const id = typeof payload.executionId === "string" ? payload.executionId : null;
    if (!id) continue;
    const commandText = [payload.subject, payload.progress].filter(value => typeof value === "string" && value).join(" ");
    const label = `${String(payload.name ?? "")} ${commandText}`;
    if (event.eventType === "tool.execution.started") {
      if (payload.operation === "execute" || SHELL_TOOL.test(label)) open.set(id, { matched: false, labelled: false });
    } else if (event.eventType !== "tool.execution.progressed") {
      open.delete(id);
      continue;
    }
    const entry = open.get(id);
    if (!entry) continue;
    // A shell name alone (\`bash\`) is not command text; a full command line in \`name\` is.
    if (commandText || /\s/.test(String(payload.name ?? "").trim())) entry.labelled = true;
    if (marker && label.includes(marker)) entry.matched = true;
  }
  return [...open.entries()].map(([executionId, entry]) => ({ executionId, matched: entry.matched, unlabelled: !entry.labelled }));
}
