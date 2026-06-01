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

export const CONCURRENT_RUN_BLOCKED_METRIC = "claude_k8s_concurrent_run_blocked_total";

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

function ensureRegistry(): { registry: Registry; counter: Counter<"agent_id" | "reason"> } {
  if (!registry || !concurrentRunBlocked) {
    registry = new Registry();
    concurrentRunBlocked = new Counter({
      name: CONCURRENT_RUN_BLOCKED_METRIC,
      help:
        "Count of claude_k8s adapter dispatch refusals (concurrent run blocked), "
        + "labeled by bounded agent_id and reason.",
      labelNames: ["agent_id", "reason"],
      registers: [registry],
    });
    // Process/runtime metrics make the scrape target carry meaningful data even
    // before any refusal is reported (manual-verification check #3 on BLO-8328).
    collectDefaultMetrics({ register: registry });
  }
  return { registry, counter: concurrentRunBlocked };
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

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  const reg = getMetricsRegistry();
  return { contentType: reg.contentType, body: await reg.metrics() };
}

/** Test-only: drop the registry so each test starts from a clean counter. */
export function __resetMetricsForTest(): void {
  registry = null;
  concurrentRunBlocked = null;
}
