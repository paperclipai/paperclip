/**
 * @fileoverview Control-plane Prometheus exposition (BLO-8328).
 *
 * Owns the process-local prom-client registry and the
 * `claude_k8s_concurrent_run_blocked_total{agent_id,reason}` counter. The
 * source event (a `claude_k8s` dispatch refusal) lives in the adapter lane;
 * this module is the D2 platform substrate that ingests those increments and
 * exposes them on `/metrics` so Prometheus can scrape them centrally
 * (see BLO-4296 for the lane split).
 *
 * Cardinality guardrail: both labels are bounded before they ever reach the
 * registry. `reason` is coerced to a fixed allow-list and `agent_id` is coerced
 * to "unknown" unless it is a member of the caller-supplied active agent
 * roster. Worst-case series count is therefore
 * `(roster_size + 1) * (KNOWN_BLOCKED_REASONS.length + 1)` — bounded by the
 * company's agent count, never by attacker- or typo-supplied ids.
 *
 * @module server/services/metrics
 */

import { Counter, Registry, collectDefaultMetrics } from "prom-client";
import { resetDepBlockedMetrics, snapshotDepBlockedMetrics } from "./dep-blocked-metrics.js";

export const CONCURRENT_RUN_BLOCKED_METRIC = "claude_k8s_concurrent_run_blocked_total";
export const HEARTBEAT_RUN_FAILED_METRIC = "paperclip_heartbeat_run_failed_total";
export const DEP_BLOCKED_WAKEUP_METRIC = "paperclip_dependency_blocked_wakeup_total";

/**
 * Bounded `reason` allow-list (mirrors the adapter-lane reasons defined in
 * BLO-4296). Anything outside this set collapses to {@link UNKNOWN_REASON} so a
 * misbehaving or compromised reporter cannot inflate cardinality via `reason`.
 */
export const KNOWN_BLOCKED_REASONS = [
  "live_job_for_active_run",
  "live_job_for_unknown_run",
  "live_job_for_terminated_run",
] as const;

export const UNKNOWN_REASON = "other";
export const UNKNOWN_AGENT_ID = "unknown";

const knownReasonSet: ReadonlySet<string> = new Set(KNOWN_BLOCKED_REASONS);

/**
 * Bounded `invocation_source` allow-list for `paperclip_heartbeat_run_failed_total`.
 * Anything outside this set collapses to "other".
 */
export const KNOWN_INVOCATION_SOURCES = [
  "github_pr_opened",
  "github_pr_synchronize",
  "github_pr_review_submitted",
  "transient_failure_retry",
  "capacity_blocked_retry",
  "issue_assigned",
  "issue_commented",
] as const;

export const UNKNOWN_INVOCATION_SOURCE = "other";

const knownInvocationSourceSet: ReadonlySet<string> = new Set(KNOWN_INVOCATION_SOURCES);

export function normalizeInvocationSource(source: string | null | undefined): string {
  return typeof source === "string" && knownInvocationSourceSet.has(source)
    ? source
    : UNKNOWN_INVOCATION_SOURCE;
}

export function normalizeReason(reason: string | null | undefined): string {
  return typeof reason === "string" && knownReasonSet.has(reason) ? reason : UNKNOWN_REASON;
}

export function normalizeAgentId(
  agentId: string | null | undefined,
  knownAgentIds: ReadonlySet<string>,
): string {
  if (typeof agentId === "string" && agentId.length > 0 && knownAgentIds.has(agentId)) {
    return agentId;
  }
  return UNKNOWN_AGENT_ID;
}

let registry: Registry | null = null;
let concurrentRunBlocked: Counter<"agent_id" | "reason"> | null = null;
let heartbeatRunFailed: Counter<"adapter" | "error_code" | "invocation_source"> | null = null;

function ensureRegistry(): {
  registry: Registry;
  counter: Counter<"agent_id" | "reason">;
  failedCounter: Counter<"adapter" | "error_code" | "invocation_source">;
} {
  if (!registry || !concurrentRunBlocked || !heartbeatRunFailed) {
    registry = new Registry();
    concurrentRunBlocked = new Counter({
      name: CONCURRENT_RUN_BLOCKED_METRIC,
      help:
        "Count of claude_k8s adapter dispatch refusals (concurrent run blocked), "
        + "labeled by bounded agent_id and reason.",
      labelNames: ["agent_id", "reason"],
      registers: [registry],
    });
    heartbeatRunFailed = new Counter({
      name: HEARTBEAT_RUN_FAILED_METRIC,
      help:
        "Count of heartbeat runs that reached terminal status 'failed', labeled by adapter type, "
        + "error_code, and invocation_source (wake reason). Used to compute webhook-driven "
        + "PR-review failure rate (BLO-7457 / BLO-9147). Cardinality bounded by allow-lists.",
      labelNames: ["adapter", "error_code", "invocation_source"],
      registers: [registry],
    });
    // Process/runtime metrics make the scrape target carry meaningful data even
    // before any refusal is reported (manual-verification check #3 on BLO-8328).
    collectDefaultMetrics({ register: registry });
  }
  return { registry, counter: concurrentRunBlocked, failedCounter: heartbeatRunFailed };
}

export function getMetricsRegistry(): Registry {
  return ensureRegistry().registry;
}

export interface RecordConcurrentRunBlockedInput {
  agentId: string | null | undefined;
  reason: string | null | undefined;
  /** Active company agent roster used to bound the `agent_id` label. */
  knownAgentIds: ReadonlySet<string>;
}

/**
 * Apply the cardinality guardrail and increment the counter. Returns the
 * normalized labels that were actually emitted (useful for logging/tests).
 */
export function recordConcurrentRunBlocked(
  input: RecordConcurrentRunBlockedInput,
): { agent_id: string; reason: string } {
  const labels = {
    agent_id: normalizeAgentId(input.agentId, input.knownAgentIds),
    reason: normalizeReason(input.reason),
  };
  ensureRegistry().counter.inc(labels);
  return labels;
}

export interface RecordHeartbeatRunFailedInput {
  /** Agent adapter type (e.g. "claude_k8s", "claude_local"). */
  adapter: string | null | undefined;
  /** Finalized error code on the heartbeat_runs row. */
  errorCode: string | null | undefined;
  /**
   * Wake reason from the run's contextSnapshot (normalized to the allow-list).
   * Maps to `invocation_source` label.
   */
  invocationSource: string | null | undefined;
}

/**
 * Increment `paperclip_heartbeat_run_failed_total`. Call once per run that
 * reaches terminal status "failed" in the liveness loop. Returns the
 * normalized labels emitted (useful for logging/tests).
 */
export function recordHeartbeatRunFailed(
  input: RecordHeartbeatRunFailedInput,
): { adapter: string; error_code: string; invocation_source: string } {
  const labels = {
    adapter: typeof input.adapter === "string" && input.adapter.length > 0 ? input.adapter : "unknown",
    error_code: typeof input.errorCode === "string" && input.errorCode.length > 0 ? input.errorCode : "unknown",
    invocation_source: normalizeInvocationSource(input.invocationSource),
  };
  ensureRegistry().failedCounter.inc(labels);
  return labels;
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  const reg = getMetricsRegistry();
  const depBlockedSnapshot = snapshotDepBlockedMetrics();
  const depBlockedBody = [
    `# HELP ${DEP_BLOCKED_WAKEUP_METRIC} Count of dependency-blocked wakeup coalescer outcomes, labeled by outcome.`,
    `# TYPE ${DEP_BLOCKED_WAKEUP_METRIC} counter`,
    ...Object.entries(depBlockedSnapshot).map(
      ([outcome, value]) => `${DEP_BLOCKED_WAKEUP_METRIC}{outcome="${outcome}"} ${value}`,
    ),
  ].join("\n");
  return { contentType: reg.contentType, body: `${await reg.metrics()}\n${depBlockedBody}\n` };
}

/** Test-only: drop the registry so each test starts from a clean counter. */
export function __resetMetricsForTest(): void {
  registry = null;
  concurrentRunBlocked = null;
  heartbeatRunFailed = null;
  resetDepBlockedMetrics();
}
