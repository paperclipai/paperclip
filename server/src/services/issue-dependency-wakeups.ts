import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
/**
 * TSMC-21406: how long a wake may sit in queued/claimed before
 * findStillBlockedDependencyWakeSuppression stops treating it as in flight.
 *
 * Generous on purpose. A real wake is claimed within seconds and its run rarely
 * outlives an hour; the rows this guards against were stuck for hours to months.
 * The cost of being wrong in the permissive direction is one duplicate wake; the
 * cost of being wrong in the strict direction is an issue silently wedged shut,
 * which is what happened.
 */
const STALE_IN_FLIGHT_DEPENDENCY_WAKE_MS = 2 * 60 * 60 * 1000;

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
 * suppress a genuinely new resolution, so suppression is recency-bounded —
 * except for permanent-hold cancel reasons (TSMC-21321).
 */
const TERMINAL_DEPENDENCY_WAKE_STATUSES = ["cancelled", "skipped"] as const;

/** How long a cancelled/skipped wake keeps suppressing identical re-emission. */
export const DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS = 15 * 60_000;

/**
 * Escalating cooldown base after the first terminal (cancelled/skipped) wake for
 * a ready state. Each additional terminal wake in the lookback doubles the hold
 * up to DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_MAX_MS.
 *
 * TSMC-21321: TSK-6133-class loops re-emitted every ~15m after aggregate-ceiling
 * cancels because a fixed window expired while the issue stayed blocked on the
 * same ready state. Escalation stops the burn without stranding genuine new
 * resolutions (those produce a different state key).
 */
export const DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS = 15 * 60_000;
export const DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_MAX_MS = 6 * 60 * 60_000;
export const DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_LOOKBACK_MS = 24 * 60 * 60_000;

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
 * Cancel errors that are board/ceiling gates, not transient dispatch failures.
 * A cancelled wake with one of these errors for a ready-state key must hold the
 * idempotency slot until the ready state itself changes (new blocker set).
 * Re-emitting every 15 minutes only burns runs that cancel again immediately
 * (TSK-6133 = 158 cancelled issue_blockers_resolved wakes / 48h, all aggregate
 * ceiling; DP-4634 same class).
 *
 * Matched against agent_wakeup_requests.error from heartbeat dispatch.
 */
const PERMANENT_HOLD_DEPENDENCY_WAKE_CANCEL_ERROR_PATTERNS: readonly RegExp[] = [
  /weighted aggregate input tokens/i,
  /board disposition is required before more generation/i,
  /generation run ceiling/i,
  /ISSUE_GENERATION_RUN_CEILING/i,
  /aggregate_input_token_ceiling/i,
];

/** True when a cancelled wake must hold the ready-state slot indefinitely. */
export function isPermanentHoldDependencyWakeCancelError(
  error: string | null | undefined,
): boolean {
  if (!error) return false;
  return PERMANENT_HOLD_DEPENDENCY_WAKE_CANCEL_ERROR_PATTERNS.some((pattern) =>
    pattern.test(error),
  );
}

/**
 * Escalating hold after N terminal wakes for the same ready state (N >= 1).
 * count=1 → base; count=2 → 2×base; … capped at max.
 */
export function computeDependencyWakeEscalatingSuppressionMs(terminalCount: number): number {
  if (terminalCount <= 0) return 0;
  const shift = Math.min(Math.max(terminalCount, 1) - 1, 10);
  const ms = DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_BASE_MS * 2 ** shift;
  return Math.min(ms, DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_MAX_MS);
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

type ExistingWakeRow = {
  id: string;
  status: string;
  idempotencyKey: string | null;
  error?: string | null;
  createdAt?: Date | null;
};

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
 * - Cancelled wakes whose error is a permanent board/ceiling gate hold the slot
 *   with NO time bound (TSMC-21321). Transient cancelled/skipped wakes still use
 *   the recency window / escalating cooldown.
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
     * omit this and keep the original live-statuses-only semantics — except
     * permanent-hold cancel errors, which always suppress.
     */
    terminalSuppressionMs?: number;
    /** Override "now" for tests. */
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
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
  const allKeys = [stateKey, ...legacyKeys];

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
        inArray(agentWakeupRequests.idempotencyKey, allKeys),
        inArray(agentWakeupRequests.status, [...TERMINAL_DEPENDENCY_WAKE_STATUSES]),
        gt(agentWakeupRequests.createdAt, new Date(now.getTime() - input.terminalSuppressionMs)),
      )
    : null;

  // Permanent-hold cancels (aggregate ceiling / board disposition) — any age.
  const permanentHoldMatch = and(
    inArray(agentWakeupRequests.idempotencyKey, allKeys),
    eq(agentWakeupRequests.status, "cancelled"),
    sql`coalesce(${agentWakeupRequests.error}, '') ~* '(weighted aggregate input tokens|board disposition is required before more generation|generation run ceiling|ISSUE_GENERATION_RUN_CEILING|aggregate_input_token_ceiling)'`,
  );

  const liveOrBounded = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      error: agentWakeupRequests.error,
      createdAt: agentWakeupRequests.createdAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        or(
          ...(terminalMatch
            ? [keyMatch, terminalMatch, permanentHoldMatch]
            : [keyMatch, permanentHoldMatch]),
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (liveOrBounded) return liveOrBounded;

  // Escalating cooldown for repeated non-permanent terminal wakes on this key.
  // Always applied (route-time + backstop) so a second cancel within N minutes
  // cannot re-burn after the fixed 15m window when emitters omit terminalSuppressionMs.
  const escalating = await findEscalatingTerminalSuppressionWake(db, {
    companyId: input.companyId,
    idempotencyKeys: allKeys,
    now,
  });
  return escalating;
}

async function findEscalatingTerminalSuppressionWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
    now: Date;
  },
): Promise<ExistingWakeRow | null> {
  if (input.idempotencyKeys.length === 0) return null;

  const lookbackStart = new Date(
    input.now.getTime() - DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_LOOKBACK_MS,
  );

  const terminalRows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      error: agentWakeupRequests.error,
      createdAt: agentWakeupRequests.createdAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, input.idempotencyKeys),
        inArray(agentWakeupRequests.status, [...TERMINAL_DEPENDENCY_WAKE_STATUSES]),
        gt(agentWakeupRequests.createdAt, lookbackStart),
      ),
    )
    .orderBy(desc(agentWakeupRequests.createdAt))
    .limit(32);

  if (terminalRows.length === 0) return null;

  // Permanent-hold rows are handled above; skip them here so we don't double-count
  // into a short escalate window when they already suppress forever.
  const actionable = terminalRows.filter(
    (row) => !isPermanentHoldDependencyWakeCancelError(row.error),
  );
  if (actionable.length === 0) return null;

  const newest = actionable[0]!;
  const holdMs = computeDependencyWakeEscalatingSuppressionMs(actionable.length);
  if (!newest.createdAt) return null;
  const elapsed = input.now.getTime() - new Date(newest.createdAt).getTime();
  if (elapsed < holdMs) {
    return newest;
  }
  return null;
}

/**
 * Fork-retained per-key lookup (upstream replaced it with the level-triggered
 * `findExistingIssueBlockersResolvedWakeForReadyState` above). Kept for callers
 * that still hold raw idempotency keys; honours the same terminal suppression,
 * permanent-hold cancels, and escalating cooldown.
 */
export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
    terminalSuppressionMs?: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

  const liveMatch = inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]);
  const statusCondition = input.terminalSuppressionMs
    ? or(
        liveMatch,
        and(
          inArray(agentWakeupRequests.status, [...TERMINAL_DEPENDENCY_WAKE_STATUSES]),
          gt(agentWakeupRequests.createdAt, new Date(now.getTime() - input.terminalSuppressionMs)),
        ),
      )
    : liveMatch;

  const permanentHoldMatch = and(
    eq(agentWakeupRequests.status, "cancelled"),
    sql`coalesce(${agentWakeupRequests.error}, '') ~* '(weighted aggregate input tokens|board disposition is required before more generation|generation run ceiling|ISSUE_GENERATION_RUN_CEILING|aggregate_input_token_ceiling)'`,
  );

  const found = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      error: agentWakeupRequests.error,
      createdAt: agentWakeupRequests.createdAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
        or(statusCondition, permanentHoldMatch),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (found) return found;

  return findEscalatingTerminalSuppressionWake(db, {
    companyId: input.companyId,
    idempotencyKeys,
    now,
  });
}

/**
 * Issue-level still-blocked suppression for the dependency-wake backstop
 * (TSMC-21321 option 2/3).
 *
 * The backstop only considers issues that are still `blocked` with ALL first-class
 * blockers ready. After one (or more) issue_blockers_resolved wakes already ran or
 * cancelled for that dependent, re-emitting on every new blocker-set digest burns
 * runs (TSR-5723: 7 completed wakes / 40m with a changing single-blocker digest).
 * Hold further backstop emits with the same escalating cooldown, keyed on the
 * dependent issue id rather than the ready-state digest. A genuinely new resolution
 * after the hold expires still gets one wake; board/resume paths do not use this
 * helper.
 */
export async function findStillBlockedDependencyWakeSuppression(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    now?: Date;
  },
): Promise<ExistingWakeRow | null> {
  const now = input.now ?? new Date();
  const lookbackStart = new Date(
    now.getTime() - DEPENDENCY_WAKE_ESCALATING_SUPPRESSION_LOOKBACK_MS,
  );

  const recent = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      error: agentWakeupRequests.error,
      createdAt: agentWakeupRequests.createdAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON),
        sql`(${agentWakeupRequests.payload} ->> 'issueId') = ${input.dependentIssueId}`,
        inArray(agentWakeupRequests.status, [
          ...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES,
          ...TERMINAL_DEPENDENCY_WAKE_STATUSES,
        ]),
        gt(agentWakeupRequests.createdAt, lookbackStart),
      ),
    )
    .orderBy(desc(agentWakeupRequests.createdAt))
    .limit(32);

  // Live in-flight wakes already suppress via the state-key path; still count them
  // so we do not double-fire while one is queued.
  if (recent.length === 0) return null;

  const newest = recent[0]!;
  if (
    newest.status === "queued" ||
    newest.status === "deferred_issue_execution" ||
    newest.status === "claimed"
  ) {
    // TSMC-21406: only a GENUINELY live wake suppresses. A wake row that has sat
    // in queued/claimed past this window is not in flight — it is leaked.
    //
    // Measured 2026-08-24: all 179 wakes stuck beyond two hours had a linked run,
    // and every one of those runs was already terminal. Because this check keys
    // purely off status, one leaked row suppressed every later
    // issue_blockers_resolved wake for its issue FOREVER — five TSMC cards sat
    // blocked with all their blockers already `done`, invisible to the fleet,
    // until they were moved by hand.
    //
    // The primary fix is upstream: the reaper now reconciles these rows and the
    // lease-release path no longer leaks them. This is the second line of defence,
    // and it is the one that matters if a leak path is ever found that the reaper
    // does not cover — a stalled wake must not be able to wedge an issue shut.
    const wakeAge = now.getTime() - (newest.createdAt?.getTime() ?? now.getTime());
    if (wakeAge <= STALE_IN_FLIGHT_DEPENDENCY_WAKE_MS) return newest;
    // Fall through: treat a stale row as history, so the escalating cooldown
    // below still applies and this cannot become a re-wake loop either.
  }

  // Permanent-hold cancels suppress forever at issue level too (any key).
  if (
    recent.some(
      (row) =>
        row.status === "cancelled" && isPermanentHoldDependencyWakeCancelError(row.error),
    )
  ) {
    return recent.find(
      (row) =>
        row.status === "cancelled" && isPermanentHoldDependencyWakeCancelError(row.error),
    )!;
  }

  const holdMs = computeDependencyWakeEscalatingSuppressionMs(recent.length);
  if (!newest.createdAt) return null;
  const elapsed = now.getTime() - new Date(newest.createdAt).getTime();
  if (elapsed < holdMs) return newest;
  return null;
}
