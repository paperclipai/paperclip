import type { CleanupReport } from "./cleanup.ts";
import type { Options } from "./config.ts";
import { criteriaTable, type CriterionResult } from "./criteria.ts";
import type { SpendEstimate } from "./estimate.ts";
import type { RampOutcome } from "./ramp.ts";
import type { Distribution } from "./stats.ts";

export type Verdict = "pass" | "fail" | "incomplete" | "interrupted" | "error";

export interface RampResult {
  schema: "paperclip.scale-ramp.result/v1";
  runId: string;
  target: { baseUrl: string; host: string; kind: string };
  startedAt: string;
  finishedAt: string;
  plan: {
    steps: Array<{ concurrency: number; holdMinutes: number }>;
    drainMinutes: number;
    pollSeconds: number;
    boardProbeSeconds: number;
    agent: { provider: string; model: string; credential: string };
    estimate: SpendEstimate;
  };
  criteria: ReturnType<typeof criteriaTable>;
  verdict: Verdict;
  stop: RampOutcome["stop"];
  steps: RampOutcome["steps"];
  notMeasured: string[];
  incompleteReasons: string[];
  drained: boolean;
  openTasksAtEnd: number;
  tasksCreated: number;
  taskCapReached: boolean;
  recordedSpendUsd: number | null;
  sources: Record<string, string>;
  cleanup: CleanupReport | null;
  requests: { total: number; failed: number };
  error: string | null;
}

export function verdictOf(outcome: RampOutcome | null, error: string | null): Verdict {
  if (error || !outcome) return "error";
  if (outcome.stop && outcome.stop.criterion) return "fail";
  if (outcome.stop) return "interrupted";
  if (outcome.steps.some(step => step.criteriaFinal.some(result => result.status === "fail"))) return "fail";
  if (incompleteReasons(outcome).length) return "incomplete";
  return "pass";
}

export function incompleteReasons(outcome: RampOutcome | null): string[] {
  if (!outcome) return [];
  const reasons: string[] = [];
  const missing = notMeasured(outcome);
  if (missing.length) reasons.push(`criteria not measured: ${missing.join(", ")}`);
  if (outcome.taskCapReached) reasons.push("the task cap was reached, so a step may have run below its concurrency");
  if (outcome.openTasksAtEnd > 0) reasons.push(`${outcome.openTasksAtEnd} tasks were still open when the drain ended`);
  return reasons;
}

export function notMeasured(outcome: RampOutcome | null): string[] {
  const ids = new Set<string>();
  for (const step of outcome?.steps ?? []) for (const result of step.criteriaFinal) if (result.status === "not_measured") ids.add(result.id);
  return [...ids];
}

export function buildResult(input: {
  options: Options;
  estimate: SpendEstimate;
  startedAt: number;
  finishedAt: number;
  outcome: RampOutcome | null;
  cleanup: CleanupReport | null;
  error: string | null;
  requests: { total: number; failed: number };
  credentialSource: string;
}): RampResult {
  const { options, outcome } = input;
  return {
    schema: "paperclip.scale-ramp.result/v1",
    runId: options.label,
    target: { baseUrl: options.target.baseUrl, host: options.target.host, kind: options.target.kind },
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    plan: {
      steps: options.steps.map(step => ({ concurrency: step.concurrency, holdMinutes: step.holdMs / 60_000 })),
      drainMinutes: options.drainMs / 60_000,
      pollSeconds: options.pollMs / 1_000,
      boardProbeSeconds: options.boardProbeMs / 1_000,
      agent: { provider: options.profile.provider, model: options.profile.model, credential: input.credentialSource },
      estimate: input.estimate,
    },
    criteria: criteriaTable(options.thresholds),
    verdict: verdictOf(outcome, input.error),
    stop: outcome?.stop ?? null,
    steps: outcome?.steps ?? [],
    notMeasured: notMeasured(outcome),
    incompleteReasons: verdictOf(outcome, input.error) === "incomplete" ? incompleteReasons(outcome) : [],
    drained: outcome?.drained ?? false,
    openTasksAtEnd: outcome?.openTasksAtEnd ?? 0,
    tasksCreated: outcome?.tasksCreated ?? 0,
    taskCapReached: outcome?.taskCapReached ?? false,
    recordedSpendUsd: outcome ? outcome.recordedSpendUsd : null,
    sources: {
      runsAndTasks: outcome?.runsListTruncated ? "API (company run list was full; open tasks without a listed run were read one by one)" : "API",
      boardLatency: "harness GET mix (dashboard, issues, agents, live runs, sidebar badges)",
      firstTokenAndActivity: `run events of up to ${options.eventSamplePerStep} succeeded runs per step`,
      serverMetrics: outcome?.metricsSource === "endpoint" ? "PAPERCLIP_SCALE_METRICS_URL"
        : outcome?.metricsSource === "unavailable" ? "PAPERCLIP_SCALE_METRICS_URL gave no readable sample: not measured" : "not provided: not measured",
      database: "not read by this harness: not measured",
    },
    cleanup: input.cleanup,
    requests: input.requests,
    error: input.error,
  };
}

const seconds = (value: number | null) => value === null ? "not measured" : `${(value / 1_000).toFixed(1)} s`;
const millis = (value: number | null) => value === null ? "not measured" : `${Math.round(value)} ms`;
const dist = (d: Distribution, format: (value: number | null) => string) => d.n === 0 ? "not measured" : `${format(d.p50)} / ${format(d.p95)} / ${format(d.p99)} (n=${d.n})`;

function criterionLine(result: CriterionResult): string {
  const observed = result.observed === null ? "not measured" : String(result.observed);
  return `  - ${result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "not measured"} ${result.id}: ${observed} (needs ${result.threshold})`;
}

export function summaryLines(result: RampResult): string[] {
  const lines = [
    `# Scale ramp ${result.runId}`,
    "",
    `Verdict: **${result.verdict}**. Target ${result.target.baseUrl} (${result.target.kind}).`,
    result.stop ? `Stopped at step ${result.stop.stepIndex + 1}: ${result.stop.reason}.` : "No stop.",
    `Tasks created: ${result.tasksCreated}${result.taskCapReached ? " (task cap reached)" : ""}. Recorded model spend: ${result.recordedSpendUsd === null ? "not measured" : `$${result.recordedSpendUsd}`}; estimate was $${result.plan.estimate.totalUsd}.`,
    "",
  ];
  for (const step of result.steps) {
    const m = step.metrics;
    lines.push(
      `## Step ${step.index + 1}: ${step.concurrency} agents, ${step.holdMs / 60_000} min`,
      "",
      `- Tasks created / started / finished / failed / needed Retry: ${m.tasksCreated} / ${m.tasksStarted} / ${m.tasksFinished} / ${m.tasksFailed} / ${m.tasksNeedingRetry}`,
      `- Runs failed / interrupted / cancelled: ${m.runsFailed} / ${m.runsInterrupted} / ${m.runsCancelled}`,
      `- Running agents peak / mean: ${m.peakRunning} / ${m.meanRunning ?? "not measured"}`,
      `- Queue wait p50 / p95 / p99: ${dist(m.queueWaitMs, seconds)}`,
      `- Time to first token p50 / p95 / p99: ${dist(m.ttftMs, seconds)}`,
      `- First activity p50 / p95 / p99: ${dist(m.firstActivityMs, seconds)}`,
      `- Run duration p50 / p95 / p99: ${dist(m.runDurationMs, seconds)}`,
      `- Board API p50 / p95 / p99: ${dist(m.board.ms, millis)}; failed ${m.board.failures} of ${m.board.requests}`,
      `- Event-loop utilization max: ${m.server.eventLoopUtilizationMax ?? "not measured"}; delay p99 max: ${millis(m.server.eventLoopDelayP99MsMax)}; statements/s max: ${m.server.statementsPerSecondMax ?? "not measured"}; pool wait p99 max: ${millis(m.server.poolWaitP99MsMax)}`,
      "- Criteria (final):",
      ...step.criteriaFinal.map(criterionLine),
      "",
    );
  }
  if (result.notMeasured.length) lines.push(`Not measured: ${result.notMeasured.join(", ")}.`, "");
  if (result.incompleteReasons.length) lines.push(`Incomplete because: ${result.incompleteReasons.join("; ")}.`, "");
  lines.push(`Drain: ${result.drained ? "every task finished" : `${result.openTasksAtEnd} tasks still open`}.`, "");
  if (result.cleanup) {
    const c = result.cleanup;
    lines.push(`Cleanup in ${seconds(c.durationMs)}: ${c.runsCancelled} runs cancelled, ${c.tasksArchived} tasks archived, ${c.agentsDeleted} agents deleted`
      + ` (${c.agentsKeptForCostHistory} kept terminated for cost history), sandbox leases still active: ${c.activeSandboxLeases ?? "not readable"}, errors: ${c.errors.length}.`);
  }
  if (result.error) lines.push(`Error: ${result.error}`);
  return lines;
}
