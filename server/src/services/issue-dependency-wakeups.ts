import { and, eq, gt, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

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

/**
 * Terminal outcomes that must still hold the idempotency slot for a cooldown.
 * A wake for the same (dependent, blocker) pair that was cancelled or skipped
 * moments ago means the system actively decided not to run it; re-emitting the
 * identical event on the next reconciler tick can only loop (observed
 * 2026-08-16: emit→cancel every ~7s, 354 cancelled wakes + 719 churned
 * continuation runs in 90 min on one issue). A stale terminal wake must NOT
 * suppress a genuinely new resolution, so suppression is recency-bounded.
 */
const TERMINAL_DEPENDENCY_WAKE_STATUSES = ["cancelled", "skipped"] as const;

/** How long a cancelled/skipped wake keeps suppressing identical re-emission. */
export const DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS = 15 * 60_000;

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
 * - The state key matches a wake in any idempotent status (including
 *   `completed`). This suppresses a duplicate wake for the SAME ready state and
 *   bounds reconciliation.
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
    /**
     * When set, a cancelled/skipped wake for the state key or one of the legacy
     * per-edge keys created within the last `terminalSuppressionMs` also counts
     * as existing, so reconciler re-scans cannot re-emit an event the system
     * just declined to run. Event-driven emitters (real resolution PATCHes)
     * omit this and keep the original live-statuses-only semantics.
     */
    terminalSuppressionMs?: number;
  },
) {
  const stateKey = buildIssueBlockersResolvedWakeStateKey({
    dependentIssueId: input.dependentIssueId,
    blockerIssueIds: input.blockerIssueIds,
  });
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

  const keyMatch = legacyMatch ? or(stateMatch, legacyMatch) : stateMatch;
  const terminalMatch = input.terminalSuppressionMs
    ? and(
        inArray(agentWakeupRequests.idempotencyKey, [stateKey, ...legacyKeys]),
        inArray(agentWakeupRequests.status, [...TERMINAL_DEPENDENCY_WAKE_STATUSES]),
        gt(agentWakeupRequests.createdAt, new Date(Date.now() - input.terminalSuppressionMs)),
      )
    : null;

  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        terminalMatch ? or(keyMatch, terminalMatch) : keyMatch,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Fork-retained per-key lookup (upstream replaced it with the level-triggered
 * `findExistingIssueBlockersResolvedWakeForReadyState` above). Kept for callers
 * that still hold raw idempotency keys; honours the same terminal suppression.
 */
export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
    terminalSuppressionMs?: number;
  },
) {
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

  const liveMatch = inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]);
  const statusCondition = input.terminalSuppressionMs
    ? or(
        liveMatch,
        and(
          inArray(agentWakeupRequests.status, [...TERMINAL_DEPENDENCY_WAKE_STATUSES]),
          gt(agentWakeupRequests.createdAt, new Date(Date.now() - input.terminalSuppressionMs)),
        ),
      )
    : liveMatch;

  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
        statusCondition,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
