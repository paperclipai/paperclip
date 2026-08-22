import { and, eq, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

// A wake counts as "still in flight" for these statuses. The `completed` status
// is not in this set on purpose. Dependency readiness is level-triggered, so a
// historical completed per-edge wake must never suppress a new wake for the
// current ready state. The dedup uses this set only for the legacy per-edge key,
// to avoid a duplicate while an old-format wake is still queued or claimed.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

/**
 * Legacy per-edge idempotency key. One key encodes a single resolved blocker
 * edge `issue_blockers_resolved:{dependentIssueId}:{resolvedBlockerIssueId}`.
 * The dedup keeps this format only to read wake rows written before the
 * level-triggered state key existed.
 */
export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state. Two wakes for the same ready state
 * share the key. A wake for an earlier partial state has a different blocker set,
 * so it produces a different key and never suppresses the current wake. All three
 * emit paths (route-time, finalize-time, periodic backstop) use this key so they
 * share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = [...new Set(input.blockerIssueIds.filter(Boolean))].sort();
  const digest = createHash("sha256")
    .update(sortedBlockerIssueIds.join(","))
    .digest("hex")
    .slice(0, 32);
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    input.dependentIssueId,
    String(sortedBlockerIssueIds.length),
    digest,
  ].join(":");
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered:
 *
 * - The state key matches an in-flight wake, or a `completed` wake requested
 *   after the latest blocker terminal transition. This suppresses a duplicate
 *   wake for the SAME ready state and lets a later reopen/close cycle create a
 *   new wake without treating unrelated blocker edits as a new cycle.
 * - Each legacy per-edge key matches only a wake that is still in flight
 *   (`queued`, `deferred_issue_execution`, `claimed`). This prevents a duplicate
 *   wake while an old-format wake is still pending after a deploy, but it never
 *   lets a historical completed per-edge wake strand the issue.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
  },
) {
  const stateKey = buildIssueBlockersResolvedWakeStateKey({
    dependentIssueId: input.dependentIssueId,
    blockerIssueIds: input.blockerIssueIds,
  });
  const blockerTerminalStateRows =
    input.blockerIssueIds.length > 0
      ? await db
          .select({
            status: issues.status,
            completedAt: issues.completedAt,
            cancelledAt: issues.cancelledAt,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              inArray(issues.id, [...new Set(input.blockerIssueIds)]),
            ),
          )
      : [];
  const latestBlockerTerminalTransitionAt = blockerTerminalStateRows.reduce<Date | null>(
    (latest, row) => {
      const transitionedAt = row.status === "done"
        ? row.completedAt
        : row.status === "cancelled"
          ? row.cancelledAt
          : null;
      return transitionedAt && (!latest || transitionedAt > latest) ? transitionedAt : latest;
    },
    null,
  );
  const legacyKeys = [
    ...new Set(
      input.blockerIssueIds
        .filter(Boolean)
        .map((resolvedBlockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: input.dependentIssueId,
            resolvedBlockerIssueId,
          }),
        ),
    ),
  ];

  const stateMatch = and(
    eq(agentWakeupRequests.idempotencyKey, stateKey),
    inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
  );
  const legacyMatch =
    legacyKeys.length > 0
      ? and(
          inArray(agentWakeupRequests.idempotencyKey, legacyKeys),
          inArray(agentWakeupRequests.status, [...IN_FLIGHT_DEPENDENCY_WAKE_STATUSES]),
        )
      : null;

  const matchingWakes = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        legacyMatch ? or(stateMatch, legacyMatch) : stateMatch,
      ),
    )
    .limit(20);

  return (
    matchingWakes.find(
      (wake) =>
        wake.idempotencyKey !== stateKey ||
        wake.status !== "completed" ||
        !latestBlockerTerminalTransitionAt ||
        wake.requestedAt >= latestBlockerTerminalTransitionAt,
    ) ?? null
  );
}
