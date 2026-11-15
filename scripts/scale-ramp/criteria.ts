import type { Step, Thresholds } from "./config.ts";
import type { Distribution } from "./stats.ts";

export interface ServerMetrics {
  mainThreadCpuMax: number | null;
  eventLoopUtilizationMax: number | null;
  eventLoopDelayP99MsMax: number | null;
  statementsPerSecondMax: number | null;
  poolWaitP99MsMax: number | null;
  runEventLatenessP99MsMax: number | null;
  agentApiPreHandlerP99MsMax: number | null;
  leaseRenewalsMissed: number | null;
  samples: number;
}

export interface StepMetrics {
  step: Step;
  startedAt: number;
  endedAt: number | null;
  tasksCreated: number;
  tasksStarted: number;
  tasksFinished: number;
  tasksFailed: number;
  tasksNeedingRetry: number;
  runsFailed: number;
  runsInterrupted: number;
  runsCancelled: number;
  peakRunning: number;
  meanRunning: number | null;
  queueWaitMs: Distribution;
  taskToStartMs: Distribution;
  ttftMs: Distribution;
  firstActivityMs: Distribution;
  runDurationMs: Distribution;
  board: { requests: number; failures: number; ms: Distribution };
  server: ServerMetrics;
  recordedSpendUsd: number;
}

export type CriterionStatus = "pass" | "fail" | "not_measured";

export interface CriterionResult {
  id: string;
  source: "finish-line" | "harness";
  description: string;
  threshold: string;
  status: CriterionStatus;
  observed: number | string | null;
}

interface Criterion {
  id: string;
  source: CriterionResult["source"];
  description: string;
  immediate: boolean;
  threshold: (t: Thresholds) => string;
  evaluate: (m: StepMetrics, t: Thresholds) => { status: CriterionStatus; observed: number | string | null };
}

const below = (value: number | null, limit: number, strict = true) =>
  value === null ? { status: "not_measured" as const, observed: null }
    : { status: (strict ? value < limit : value <= limit) ? "pass" as const : "fail" as const, observed: value };

export const CRITERIA: readonly Criterion[] = [
  {
    id: "retry_needed_zero", source: "finish-line", immediate: true,
    description: "Runs that need Retry (a task offered the Retry action)",
    threshold: () => "= 0",
    evaluate: m => ({ status: m.tasksNeedingRetry === 0 ? "pass" : "fail", observed: m.tasksNeedingRetry }),
  },
  {
    id: "failed_runs_zero", source: "harness", immediate: true,
    description: "Runs that ended failed or timed out",
    threshold: () => "= 0",
    evaluate: m => ({ status: m.runsFailed === 0 ? "pass" : "fail", observed: m.runsFailed }),
  },
  {
    id: "tasks_rested_not_done_zero", source: "harness", immediate: false,
    description: "Tasks that came to rest without being done (blocked, in review or cancelled)",
    threshold: () => "= 0",
    evaluate: m => ({ status: m.tasksFailed === 0 ? "pass" : "fail", observed: m.tasksFailed }),
  },
  {
    id: "concurrency_reached", source: "harness", immediate: false,
    description: "Peak running agents against the step target",
    threshold: t => `>= ${Math.round(t.minConcurrencyRatio * 100)}% of the step`,
    evaluate: (m, t) => ({ status: m.peakRunning >= Math.ceil(m.step.concurrency * t.minConcurrencyRatio) ? "pass" : "fail", observed: m.peakRunning }),
  },
  {
    id: "board_api_p90", source: "finish-line", immediate: false,
    description: "Board page API requests, p90 (ms)",
    threshold: t => `< ${t.boardP90Ms} ms`,
    evaluate: (m, t) => m.board.ms.n < 3 ? { status: "not_measured", observed: null } : below(m.board.ms.p90, t.boardP90Ms),
  },
  {
    id: "board_api_errors_zero", source: "harness", immediate: false,
    description: "Board API requests that failed (no answer, 4xx or 5xx)",
    threshold: () => "= 0",
    evaluate: m => m.board.requests === 0 ? { status: "not_measured", observed: null } : { status: m.board.failures === 0 ? "pass" : "fail", observed: m.board.failures },
  },
  {
    id: "queue_wait_p95", source: "harness", immediate: false,
    description: "Queue wait before a run starts, p95 (ms)",
    threshold: t => `<= ${t.queueWaitP95Ms} ms`,
    evaluate: (m, t) => below(m.queueWaitMs.p95, t.queueWaitP95Ms, false),
  },
  {
    id: "first_activity_p95", source: "harness", immediate: false,
    description: "First visible agent activity from run creation, p95 (ms), from sampled run events",
    threshold: t => `<= ${t.firstActivityP95Ms} ms`,
    evaluate: (m, t) => below(m.firstActivityMs.p95, t.firstActivityP95Ms, false),
  },
  {
    id: "main_thread_cpu", source: "finish-line", immediate: false,
    description: "Main-thread CPU (or event-loop utilization) of every server process, max",
    threshold: t => `< ${t.maxEventLoopUtilization}`,
    evaluate: (m, t) => below(m.server.mainThreadCpuMax ?? m.server.eventLoopUtilizationMax, t.maxEventLoopUtilization),
  },
  {
    id: "run_event_lateness_p99", source: "finish-line", immediate: false,
    description: "Run event lateness (runner emits to row committed), p99 (ms)",
    threshold: t => `< ${t.runEventLatenessP99Ms} ms`,
    evaluate: (m, t) => below(m.server.runEventLatenessP99MsMax, t.runEventLatenessP99Ms),
  },
  {
    id: "agent_api_pre_handler_p99", source: "finish-line", immediate: false,
    description: "Agent API request time before the handler, p99 (ms)",
    threshold: t => `< ${t.agentApiPreHandlerP99Ms} ms`,
    evaluate: (m, t) => below(m.server.agentApiPreHandlerP99MsMax, t.agentApiPreHandlerP99Ms),
  },
  {
    id: "lease_renewals_missed_zero", source: "finish-line", immediate: false,
    description: "Lease renewals that missed their deadline",
    threshold: () => "= 0",
    evaluate: m => m.server.leaseRenewalsMissed === null ? { status: "not_measured", observed: null }
      : { status: m.server.leaseRenewalsMissed === 0 ? "pass" : "fail", observed: m.server.leaseRenewalsMissed },
  },
  {
    id: "kill_one_process_resumes", source: "finish-line", immediate: false,
    description: "Killing one server process: its runs resume on another, no Retry",
    threshold: () => "resume, no Retry",
    evaluate: () => ({ status: "not_measured", observed: "this harness does not kill server processes" }),
  },
];

export function evaluate(metrics: StepMetrics, thresholds: Thresholds, onlyImmediate = false): CriterionResult[] {
  return CRITERIA.filter(criterion => !onlyImmediate || criterion.immediate).map(criterion => ({
    id: criterion.id,
    source: criterion.source,
    description: criterion.description,
    threshold: criterion.threshold(thresholds),
    ...criterion.evaluate(metrics, thresholds),
  }));
}

export function criteriaTable(thresholds: Thresholds): Array<Pick<CriterionResult, "id" | "source" | "description" | "threshold">> {
  return CRITERIA.map(criterion => ({ id: criterion.id, source: criterion.source, description: criterion.description, threshold: criterion.threshold(thresholds) }));
}

export const firstFailure = (results: readonly CriterionResult[]) => results.find(result => result.status === "fail") ?? null;
