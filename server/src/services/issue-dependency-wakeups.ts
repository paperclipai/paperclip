import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

/**
 * Whether moving an issue into `blocked` should immediately wake its assignee
 * because every recorded blocker is already resolved ("blockers restored").
 *
 * The assignee agent blocking its own issue is declaring a wait on something
 * outside the blocker graph (a pending confirmation, a human action). Waking it
 * straight back made it re-block in a loop: every re-block stamps a new
 * `blockedTransitionAt`, so the ready-state dedup key never matched and the
 * agent was woken again on each run (five wakes in four minutes observed).
 * Board or other-actor transitions and assignee changes still wake, and the
 * dependency backstop still covers a genuinely stranded issue.
 */
export function shouldWakeOnRestoredBlockedDependency(input: {
  previousStatus: string;
  nextStatus: string;
  previousAssigneeAgentId: string | null;
  nextAssigneeAgentId: string | null;
  blockerSetEdited: boolean;
  hasUnblockDescriptor: boolean;
  actorType: string;
  actorAgentId: string | null;
}): boolean {
  if (input.nextStatus !== "blocked" || !input.nextAssigneeAgentId) return false;
  // A row that carries an unblock descriptor is parked on judgement, so the
  // dependency that just became ready is not what it waits for. Use the same
  // rule as the other emit paths: the descriptor-owner wake
  // (`issue_unblock_requested`) owns this row, and a resolved-dependency wake
  // for it only queues a run that expires unstarted.
  if (
    !classifyResolvedDependencyWakeTarget({
      status: input.nextStatus,
      hasUnblockDescriptor: input.hasUnblockDescriptor,
    }).emit
  ) {
    return false;
  }
  const assigneeChanged = input.previousAssigneeAgentId !== input.nextAssigneeAgentId;
  if (input.previousStatus === "blocked" && !input.blockerSetEdited && !assigneeChanged) return false;
  const selfBlockedByAssignee =
    input.actorType === "agent" &&
    input.actorAgentId !== null &&
    input.actorAgentId === input.nextAssigneeAgentId &&
    !assigneeChanged;
  return !selfBlockedByAssignee;
}

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
// current ready state. The dedup uses this set only for the legacy per-edge key
// and for old no-cycle state keys that are still queued after a deploy.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_DEPENDENCY_WAKE_STATUSES);
const IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IN_FLIGHT_DEPENDENCY_WAKE_STATUSES);

export type IssueBlockersResolvedWakeCycleInput = Date | string | null | undefined;

export type ResolvedDependencyWakeSuppression =
  | "descriptor_parked"
  | "terminal_status";

export type ResolvedDependencyWakeTargetDecision = {
  /** True when a resolved-dependency wake may be emitted for this target. */
  emit: boolean;
  /** Why the wake was withheld, or null when `emit` is true. */
  suppression: ResolvedDependencyWakeSuppression | null;
};

/**
 * Which issues may receive an `issue_blockers_resolved` wake.
 *
 * A dependency-resolved wake says "the thing that was holding this issue is
 * done, go look again". That is true for a row blocked by `issueRelations`. It
 * is not true for a row parked on judgement (`unblockDescriptor`): its wake is
 * the descriptor-owner notification (`issue_unblock_requested`, delivered once
 * per blocked cycle by routeParkedBlockDescriptor), and re-arming a
 * resolved-dependency run for it produces a queued run that can only expire
 * unstarted, forever, one rung per backstop tick.
 *
 * Measured 2026-10-22 on a live 2026.831.1 instance: 45 `issue_blockers_resolved`
 * wakes in 8 h, with VOY-8946 and VOY-9110 each re-armed on an exact hourly
 * ladder and every rung cancelled at the 60 min queue bound
 * (`queued_run_expired`). Both rows already had their descriptor-owner wake
 * (`blocked_owner_notified_at` set).
 *
 * Unknown statuses fail open: a new non-terminal status must not silently lose
 * its dependency wake.
 */
export function classifyResolvedDependencyWakeTarget(input: {
  status: string | null | undefined;
  hasUnblockDescriptor: boolean;
}): ResolvedDependencyWakeTargetDecision {
  const status = typeof input.status === "string" ? input.status : null;
  if (status === "done" || status === "cancelled") {
    return { emit: false, suppression: "terminal_status" };
  }
  if (status === "blocked" && input.hasUnblockDescriptor === true) {
    return { emit: false, suppression: "descriptor_parked" };
  }
  return { emit: true, suppression: null };
}

export type IssueBlockersResolvedReadyStateInput = {
  dependentIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Canonical blocked-cycle stamp for the dependency-ready state key.
 * `blockedTransitionAt` is UTC ISO-8601, or `none` when the dependent has no
 * recorded transition into `blocked`.
 */
export function formatIssueBlockersResolvedWakeCycle(
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput,
): string {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return "none";
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return "none";
  return parsed.toISOString();
}

function uniqueSortedBlockerIssueIds(blockerIssueIds: string[]): string[] {
  return [...new Set(blockerIssueIds.filter(Boolean))].sort();
}

function hashBlockerReadyStateDigest(sortedBlockerIssueIds: string[], cycle: string | null): string {
  const payload = cycle == null
    ? sortedBlockerIssueIds.join(",")
    : `${sortedBlockerIssueIds.join(",")}\n${cycle}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function buildStateKey(dependentIssueId: string, digest: string, blockerCount: number): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    dependentIssueId,
    String(blockerCount),
    digest,
  ].join(":");
}

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
 * Pre-cycle level-triggered key. Rows written before the ready state included
 * `blockedTransitionAt` hashed only the sorted blocker ids. Lookup still reads
 * this format so an in-flight deploy-overlap wake can suppress a duplicate.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state plus the dependent's current
 * blocked cycle (`blockedTransitionAt`, or `none`). Two wakes for the same ready
 * state share the key. A wake from an earlier blocked cycle has a different
 * cycle stamp, so it produces a different key and never suppresses the current
 * wake. All three emit paths (route-time, finalize-time, periodic backstop) use
 * this key so they share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

function parseWakeCycleDate(blockedTransitionAt: IssueBlockersResolvedWakeCycleInput): Date | null {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return null;
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function wakeCoversIssueBlockersResolvedReadyState(
  wake: {
    status: string;
    idempotencyKey: string | null;
    requestedAt: Date;
  },
  keys: {
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  if (idempotencyKey === keys.cycleKey) {
    return IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  if (idempotencyKey === keys.oldStateKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (wake.status !== "completed") return false;
    if (!keys.blockedTransitionAt) return true;
    return wake.requestedAt.getTime() >= keys.blockedTransitionAt.getTime();
  }

  if (keys.legacyKeys.has(idempotencyKey)) {
    return IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  return false;
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered and cycle-aware:
 *
 * - The cycle-aware state key matches a wake in any idempotent status
 *   (including `completed`). This suppresses a duplicate for the SAME ready
 *   state, including the current blocked cycle.
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after the current
 *   `blockedTransitionAt` (same cycle). A completed old-key wake from a
 *   previous cycle does not suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
) {
  const cycleKey = buildIssueBlockersResolvedWakeStateKey(input);
  const oldStateKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input);
  const legacyKeyList = [
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
  const lookupKeys = [...new Set([cycleKey, oldStateKey, ...legacyKeyList])];
  const blockedTransitionAt = parseWakeCycleDate(input.blockedTransitionAt);

  const rows = await db
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
        inArray(agentWakeupRequests.idempotencyKey, lookupKeys),
      ),
    );

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
    }),
  );
  return covering ?? null;
}
