/**
 * Per-agent WIP caps: what they mean, how to read them, and how to count.
 *
 * Two caps exist and they are not interchangeable. Conflating them is the bug
 * this module exists to prevent.
 *
 * | cap | counts | enforced at | question it answers |
 * |---|---|---|---|
 * | `maxInFlightIssues` | issues holding a live execution lock | dispatch | "how many issues have a run bound to them right now" |
 * | `maxInProgressIssues` | issues whose status says `in_progress` | status transition | "how many issues has this agent claimed" |
 *
 * The first is a fact and the second is a claim, and a claim exists strictly
 * before the fact does. K-19938 measured an agent holding 26 `in_progress`
 * issues against a real in-flight count of 2: a run cap is structurally blind
 * to the 24 issues that had not yet produced a run, which is exactly the window
 * in which over-claiming happens. Bounding the run cannot bound the claim, so
 * the claim needs its own ceiling.
 *
 * The asymmetry in what each one counts is deliberate, not an oversight. The
 * in-flight cap must ignore labels, because counting labels is what let phantom
 * slots accumulate and made dispatch behave like a fleet at capacity while one
 * agent was at capacity. The label cap must count labels, because that is the
 * quantity it governs.
 *
 * Phantoms a label cap can accumulate are not left to rot: the
 * `stale_in_progress_repair` sweep demotes `in_progress` issues with no run and
 * no lock, so an agent held at the cap by a stale claim is released on a bounded
 * cadence rather than permanently.
 */

import {
  AGENT_DEFAULT_MAX_IN_FLIGHT_ISSUES,
  AGENT_DEFAULT_MAX_IN_PROGRESS_ISSUES,
  AGENT_MAX_MAX_IN_FLIGHT_ISSUES,
  AGENT_MAX_MAX_IN_PROGRESS_ISSUES,
  AGENT_MIN_MAX_IN_FLIGHT_ISSUES,
  AGENT_MIN_MAX_IN_PROGRESS_ISSUES,
} from "./constants.js";

type RuntimeConfigRecord = Record<string, unknown>;

function readHeartbeatBlock(runtimeConfig: unknown): RuntimeConfigRecord {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return {};
  const heartbeat = (runtimeConfig as RuntimeConfigRecord).heartbeat;
  if (!heartbeat || typeof heartbeat !== "object") return {};
  return heartbeat as RuntimeConfigRecord;
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

/**
 * Resolve `heartbeat.maxInFlightIssues` — the lock-based cap used by dispatch.
 *
 * Three aliases exist because the concept has been written down three ways in
 * incident reports. An explicit value always wins; only absence falls back to
 * the honest default, so a company that deliberately widened its agents keeps
 * doing so.
 */
export function resolveMaxInFlightIssues(
  runtimeConfig: unknown,
  rawValue?: unknown,
): number {
  return clampInteger(
    rawValue ?? readHeartbeatBlock(runtimeConfig).maxInFlightIssues,
    AGENT_DEFAULT_MAX_IN_FLIGHT_ISSUES,
    AGENT_MIN_MAX_IN_FLIGHT_ISSUES,
    AGENT_MAX_MAX_IN_FLIGHT_ISSUES,
  );
}

/**
 * Resolve `heartbeat.maxInProgressIssues` — the claim-based cap enforced when an
 * issue is moved to `in_progress`.
 *
 * Same alias-and-default contract as {@link resolveMaxInFlightIssues}. Passing
 * an explicit `rawValue` bypasses config lookup, which is what the create-time
 * normalizers use when they are reading a value they are about to write.
 */
export function resolveMaxInProgressIssues(
  runtimeConfig: unknown,
  rawValue?: unknown,
): number {
  return clampInteger(
    rawValue ?? readHeartbeatBlock(runtimeConfig).maxInProgressIssues,
    AGENT_DEFAULT_MAX_IN_PROGRESS_ISSUES,
    AGENT_MIN_MAX_IN_PROGRESS_ISSUES,
    AGENT_MAX_MAX_IN_PROGRESS_ISSUES,
  );
}

/**
 * Decide whether a claim is allowed, and describe the shortfall if not.
 *
 * Pure so the rule is unit-testable without a database, and so the same
 * arithmetic cannot drift between the write path and whatever surfaces the cap.
 *
 * `currentCount` must exclude the issue being claimed. Passing a count that
 * already includes it makes the second claim on a cap of 1 look like the third
 * on a cap of 2 — an off-by-one that would only show up as a phantom
 * "already at cap" on the very first claim.
 */
export function evaluateAgentWipCap(input: {
  cap: number;
  currentCount: number;
  issueIdentifier?: string | null;
}): { allowed: true } | { allowed: false; cap: number; currentCount: number; reason: "wip_cap_exceeded" } {
  const cap = clampInteger(
    input.cap,
    AGENT_DEFAULT_MAX_IN_PROGRESS_ISSUES,
    AGENT_MIN_MAX_IN_PROGRESS_ISSUES,
    AGENT_MAX_MAX_IN_PROGRESS_ISSUES,
  );
  const currentCount = Math.max(0, Math.floor(Number(input.currentCount) || 0));
  if (currentCount < cap) return { allowed: true };
  return { allowed: false, cap, currentCount, reason: "wip_cap_exceeded" };
}
