/**
 * RTB execution control ÔÇö bounded lifecycle, compaction, and structured telemetry.
 *
 * This module implements the decision logic required by KOMAA-166 (P0 RTB
 * EXECUTION CONTROL) as pure, framework-free functions so they can be unit
 * tested with fault injection and wired into the heartbeat/recovery paths
 * without changing existing call-site types.
 *
 * It deliberately does NOT create meta-issues (stale_active_run_evaluation /
 * issue_productivity_review) for the RTB default: detection updates persisted
 * watchdog/execution state and emits an event/comment only when needed. A new
 * issue is created only for an independent deliverable or via the explicit
 * opt-in legacy path.
 */

export type RunBudgetProfile = "normal" | "debug" | "complex";

/** Per-source-issue model-call budget guardrails (KOMAA-166 C). */
export const RUN_BUDGET_BY_PROFILE: Readonly<Record<RunBudgetProfile, number>> = {
  normal: 4,
  debug: 6,
  complex: 8,
};

export const DEFAULT_RUN_BUDGET_PROFILE: RunBudgetProfile = "normal";

/** Maximum automatic recovery continuations for a single silent/stalled run. */
export const MAX_AUTO_RECOVERIES = 1;

/** If cached-input replay exceeds this, fork instead of compact (KOMAA-166 C). */
export const COMPACT_FORK_CACHED_INPUT_THRESHOLD = 2_000_000;

/** Output-silence thresholds in ms (KOMAA-166 B). */
export const DEFAULT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const DEFAULT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/** Bounded size for a compacted continuation prompt (KOMAA-166 C). */
export const MAX_COMPACT_CONTINUATION_CHARS = 4000;

export type WatchdogSeverity = "ok" | "suspicious" | "critical" | "not_applicable";

export type WatchdogAction =
  | "none" // ok / not_applicable: do nothing
  | "state_only" // suspicious: persisted state/event only, no model, no meta-issue
  | "terminalize" // critical + no progress / budget exhausted: cancel run
  | "recover"; // critical + liveness confirmed: single bounded recovery

export interface WatchdogTickInput {
  severity: WatchdogSeverity;
  /** Automatic recovery continuations already performed for this run. */
  priorRecoveryCount: number;
  /** Process/orphan liveness still shows the run making progress. */
  livenessProgress: boolean;
  /** An open meta-issue (stale_active_run_evaluation / issue_productivity_review) already exists for the source. */
  openMetaIssueExists: boolean;
  /** Opt-in legacy path; RTB default is false (no meta-issue churn). */
  allowMetaIssue?: boolean;
}

export interface WatchdogDecision {
  severity: WatchdogSeverity;
  invokeModel: boolean;
  createMetaIssue: boolean;
  action: WatchdogAction;
  reason: string;
}

/**
 * Decide what a single watchdog tick should do for a run.
 *
 * Invariants (KOMAA-166 A/B, acceptance #2/#3):
 *  - ok / not_applicable => no model, no meta-issue.
 *  - suspicious => persisted state only; zero model invocations, zero new meta-issue.
 *  - critical => at most ONE automatic recovery; otherwise terminalize.
 *  - meta-issue creation is disabled by default (RTB no-meta-issue churn).
 */
export function decideWatchdogTick(input: WatchdogTickInput): WatchdogDecision {
  const { severity, priorRecoveryCount, livenessProgress, openMetaIssueExists, allowMetaIssue } = input;

  if (severity === "ok" || severity === "not_applicable") {
    return {
      severity,
      invokeModel: false,
      createMetaIssue: false,
      action: "none",
      reason: "within thresholds or not applicable",
    };
  }

  if (severity === "suspicious") {
    return {
      severity,
      invokeModel: false,
      createMetaIssue: false,
      action: "state_only",
      reason: "suspicious: persisted state/event only; no model, no meta-issue",
    };
  }

  // severity === "critical"
  if (priorRecoveryCount >= MAX_AUTO_RECOVERIES) {
    return {
      severity,
      invokeModel: false,
      createMetaIssue: false,
      action: "terminalize",
      reason: "critical: automatic recovery budget exhausted; terminalize run",
    };
  }

  if (!livenessProgress) {
    return {
      severity,
      invokeModel: false,
      createMetaIssue: false,
      action: "terminalize",
      reason: "critical: no process liveness/progress; terminalize run",
    };
  }

  const createMetaIssue = Boolean(allowMetaIssue) && !openMetaIssueExists;
  return {
    severity,
    invokeModel: false,
    createMetaIssue,
    action: "recover",
    reason: createMetaIssue
      ? "critical: liveness confirmed; single bounded recovery + legacy meta-issue"
      : "critical: liveness confirmed; single bounded recovery, no meta-issue",
  };
}

/**
 * Idempotency guard for meta-issue creation (KOMAA-166 A, acceptance #3).
 * Never open a new stale_active_run_evaluation / issue_productivity_review when
 * one is already open for the same source.
 */
export function shouldOpenNewMetaIssue(openMetaIssueExists: boolean): boolean {
  return !openMetaIssueExists;
}

export type BudgetStrategy = "within" | "compact" | "fork" | "block";

export interface RunBudgetUsage {
  modelCalls: number;
  /** Cached-input tokens of the latest replay; used to pick fork vs compact. */
  cachedInputTokens?: number;
}

export interface BudgetEvaluation {
  profile: RunBudgetProfile;
  limit: number;
  used: number;
  exceeded: boolean;
  strategy: BudgetStrategy;
  reason: string;
}

/**
 * Evaluate the per-source-issue model-call budget (KOMAA-166 C, acceptance #4).
 * On breach, choose a compact (bounded) or fork continuation instead of a full
 * replay. Never silently launches another unbounded heartbeat.
 */
export function evaluateRunBudget(
  usage: RunBudgetUsage,
  profile: RunBudgetProfile = DEFAULT_RUN_BUDGET_PROFILE,
): BudgetEvaluation {
  const limit = RUN_BUDGET_BY_PROFILE[profile];
  const used = usage.modelCalls;

  if (used <= limit) {
    return { profile, limit, used, exceeded: false, strategy: "within", reason: "within budget" };
  }

  const cached = usage.cachedInputTokens ?? 0;
  const strategy: BudgetStrategy = cached > COMPACT_FORK_CACHED_INPUT_THRESHOLD ? "fork" : "compact";
  return {
    profile,
    limit,
    used,
    exceeded: true,
    strategy,
    reason: `model-call budget exceeded (${used}/${limit}); ${strategy} continuation`,
  };
}

export interface ContinuationContext {
  objective: string;
  decisions: string[];
  changedFiles: string[];
  tests: string[];
  blockers: string[];
  nextAction: string;
  runtimeIds?: Record<string, string>;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\nÔÇŽ[truncated]` : value;
}

/**
 * Build a bounded continuation prompt that preserves only the objective,
 * decisions, changed files, tests, blockers, next action and essential runtime
 * IDs (KOMAA-166 C, acceptance #4). The result is always truncated to
 * MAX_COMPACT_CONTINUATION_CHARS so a continuation never replays the full
 * multi-million-token context.
 */
export function buildCompactContinuationPrompt(ctx: ContinuationContext): string {
  const sections: string[] = [];
  sections.push(`OBJECTIVE:\n${truncate(ctx.objective, 800)}`);
  sections.push(`DECISIONS:\n${ctx.decisions.map((d) => `- ${d}`).join("\n") || "- (none)"}`);
  sections.push(`CHANGED FILES:\n${ctx.changedFiles.map((f) => `- ${f}`).join("\n") || "- (none)"}`);
  sections.push(`TESTS:\n${ctx.tests.map((t) => `- ${t}`).join("\n") || "- (none)"}`);
  sections.push(`BLOCKERS:\n${ctx.blockers.map((b) => `- ${b}`).join("\n") || "- (none)"}`);
  sections.push(`NEXT ACTION:\n${ctx.nextAction}`);
  if (ctx.runtimeIds && Object.keys(ctx.runtimeIds).length > 0) {
    sections.push(`RUNTIME IDS:\n${Object.entries(ctx.runtimeIds).map(([k, v]) => `- ${k}=${v}`).join("\n")}`);
  }

  let out = sections.join("\n\n");
  const suffix = "\nÔÇŽ[truncated to bounded size]";
  if (out.length > MAX_COMPACT_CONTINUATION_CHARS) {
    out = `${out.slice(0, Math.max(0, MAX_COMPACT_CONTINUATION_CHARS - suffix.length))}${suffix}`;
  }
  return out;
}

export type RunTelemetryEventType =
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "search"
  | "file_read"
  | "file_write"
  | "test"
  | "retry"
  | "model_call";

export interface RunTelemetryEvent {
  eventType: RunTelemetryEventType;
  /** Epoch milliseconds. */
  timestamp: number;
  /** Success flag for tool_call / tool_result style events. */
  ok?: boolean;
}

export interface StructuredRunMetrics {
  toolCalls: number;
  failedToolCalls: number;
  retryCount: number;
  searchCalls: number;
  fileReads: number;
  fileWrites: number;
  testCalls: number;
  timeToFirstWriteMs: number | null;
  timeToFirstTestMs: number | null;
  usage: Record<string, unknown> | null;
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  /** True when counters were derived from persisted events rather than estimated. */
  derived: boolean;
  /** Fields the engine does not support, each with a reason. */
  unsupported: string[];
}

export interface DeriveTelemetryInput {
  events: RunTelemetryEvent[];
  /** Epoch milliseconds when the run started. */
  runStartedAt: number;
  usage?: Record<string, unknown> | null;
  durationMs?: number | null;
  provider?: string | null;
  model?: string | null;
}

/**
 * Derive structured execution telemetry from persisted run events
 * (KOMAA-166 D, acceptance #5). Counters are computed from the event stream and
 * are never estimated. `usage`/`duration`/`provider`/`model` are passed through
 * from the existing public run metrics.
 */
export function deriveStructuredRunMetrics(input: DeriveTelemetryInput): StructuredRunMetrics {
  const { events, runStartedAt } = input;

  let toolCalls = 0;
  let failedToolCalls = 0;
  let retryCount = 0;
  let searchCalls = 0;
  let fileReads = 0;
  let fileWrites = 0;
  let testCalls = 0;
  let firstWriteTs: number | null = null;
  let firstTestTs: number | null = null;

  for (const e of events) {
    switch (e.eventType) {
      case "tool_call":
        toolCalls += 1;
        if (e.ok === false) failedToolCalls += 1;
        break;
      case "tool_error":
        failedToolCalls += 1;
        break;
      case "retry":
        retryCount += 1;
        break;
      case "search":
        searchCalls += 1;
        break;
      case "file_read":
        fileReads += 1;
        break;
      case "file_write":
        fileWrites += 1;
        if (firstWriteTs === null) firstWriteTs = e.timestamp;
        break;
      case "test":
        testCalls += 1;
        if (firstTestTs === null) firstTestTs = e.timestamp;
        break;
      case "tool_result":
      case "model_call":
      default:
        break;
    }
  }

  return {
    toolCalls,
    failedToolCalls,
    retryCount,
    searchCalls,
    fileReads,
    fileWrites,
    testCalls,
    timeToFirstWriteMs: firstWriteTs === null ? null : firstWriteTs - runStartedAt,
    timeToFirstTestMs: firstTestTs === null ? null : firstTestTs - runStartedAt,
    usage: input.usage ?? null,
    durationMs: input.durationMs ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    derived: true,
    unsupported: [],
  };
}

/**
 * Map a persisted `heartbeat_run_events` row into a normalized telemetry event.
 * Returns null for rows that do not carry a recognized telemetry signal, so a
 * missing adapter mapping degrades gracefully instead of corrupting metrics.
 */
export function normalizeHeartbeatRunEvent(row: {
  eventType: string;
  payload?: Record<string, unknown> | null;
  createdAt: Date | string | number;
}): RunTelemetryEvent | null {
  const timestamp =
    row.createdAt instanceof Date
      ? row.createdAt.getTime()
      : typeof row.createdAt === "string" || typeof row.createdAt === "number"
        ? new Date(row.createdAt).getTime()
        : NaN;
  if (Number.isNaN(timestamp)) return null;

  const type = row.eventType;
  const payload = row.payload ?? {};

  switch (type) {
    case "tool_call":
    case "tool_error":
    case "tool_result":
    case "search":
    case "file_read":
    case "file_write":
    case "test":
    case "retry":
    case "model_call":
      return { eventType: type, timestamp, ok: payload.ok === false ? false : undefined };
    default:
      return null;
  }
}
