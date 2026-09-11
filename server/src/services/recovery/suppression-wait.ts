/**
 * Durable parking for suppressed wake intents.
 *
 * A wake that a current guard refuses (issue dependencies blocked, task drain,
 * worktree/restore suppression) used to be recorded as a terminal `skipped`
 * wakeup row and then re-derived and re-discarded by the next sweep — the
 * discarded-wake storm. The parked carrier is the SAME deferred-wake carrier
 * the issue-busy path already uses: one `agent_wakeup_requests` row in
 * `deferred_issue_execution` per (company, agent, issue), holding the ORIGINAL
 * identity, payload and source-run context under `_paperclipWakeContext`, with
 * `coalescedCount` counting every later re-derivation instead of minting new
 * rows. Release re-evaluates the current guard (dependency readiness /
 * scheduling suppression) before a single admitted execution; nothing here
 * bypasses a real human gate.
 */

export const SUPPRESSED_WAKE_DEFERRED_CONTEXT_KEY = "_paperclipWakeContext";

export type SuppressedWakeParkCause =
  | "issue_dependencies_blocked"
  | "scheduling_suppressed";

export type SuppressedWakeParkMarker = {
  cause: SuppressedWakeParkCause;
  /** First park time — the original intent identity anchor. */
  parkedAt: string;
  /** Latest discarded re-derivation of the same intent. */
  lastSuppressedAt: string;
  /** Total discarded re-derivations of this intent, including the first park. */
  suppressions: number;
  /**
   * In-place recheck count at promotion while the guard still held. Rate-
   * bounded only: a legitimate unchanged wait keeps rechecking forever on an
   * escalating backoff — the wait lifetime is owned by the guard (the
   * blocker's owner), never by a clock.
   */
  rechecks: number;
  /** Original wake reason — restored onto the promoted run. */
  wakeReason?: string | null;
  /** Scheduling-suppression reason (`task_drain`, `worktree_instance`, …). */
  schedulingReason?: string | null;
  /** Original wake idempotency key — part of the intent identity. */
  idempotencyKey?: string | null;
  /** Original source run the intent continues — part of the intent identity. */
  retryOfRunId?: string | null;
  /** Dependency-park payload: the blocker set the intent is parked behind. */
  unresolvedBlockerIssueIds?: string[];
};

/** Base recheck cadence for a parked dependency wait (60s ± workspace-busy jitter). */
export const DEPENDENCY_WAIT_RECHECK_BASE_DELAY_MS = 60_000;
/** Ceiling for the escalating recheck cadence. */
export const DEPENDENCY_WAIT_RECHECK_MAX_DELAY_MS = 15 * 60_000;

/**
 * Escalating, bounded-RATE recheck delay for an unchanged dependency wait:
 * 60s doubling per recheck up to 15min. The wait itself is unbounded — the
 * blocker's explicit owner decides when it ends; the rate only protects the
 * promotion loop from busy-polling.
 */
export function dependencyWaitRecheckDelayMs(
  rechecks: number,
  jitterMs = 0,
): number {
  const exponential =
    DEPENDENCY_WAIT_RECHECK_BASE_DELAY_MS *
    2 ** Math.max(0, Math.min(rechecks, 4));
  return Math.min(exponential, DEPENDENCY_WAIT_RECHECK_MAX_DELAY_MS) + jitterMs;
}

export function readSuppressedWakeParkMarker(
  context: unknown,
): SuppressedWakeParkMarker | null {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const marker = (context as Record<string, unknown>).suppressedWakePark;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const record = marker as Record<string, unknown>;
  const cause = record.cause;
  if (cause !== "issue_dependencies_blocked" && cause !== "scheduling_suppressed") {
    return null;
  }
  const parkedAt = typeof record.parkedAt === "string" ? record.parkedAt : null;
  if (!parkedAt) return null;
  const unresolvedBlockerIssueIds = Array.isArray(record.unresolvedBlockerIssueIds)
    ? record.unresolvedBlockerIssueIds.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  return {
    cause,
    parkedAt,
    lastSuppressedAt:
      typeof record.lastSuppressedAt === "string" ? record.lastSuppressedAt : parkedAt,
    suppressions:
      typeof record.suppressions === "number" && Number.isFinite(record.suppressions)
        ? Math.max(1, Math.floor(record.suppressions))
        : 1,
    rechecks:
      typeof record.rechecks === "number" && Number.isFinite(record.rechecks)
        ? Math.max(0, Math.floor(record.rechecks))
        : 0,
    wakeReason: typeof record.wakeReason === "string" ? record.wakeReason : null,
    schedulingReason:
      typeof record.schedulingReason === "string" ? record.schedulingReason : null,
    idempotencyKey:
      typeof record.idempotencyKey === "string" && record.idempotencyKey.length > 0
        ? record.idempotencyKey
        : null,
    retryOfRunId:
      typeof record.retryOfRunId === "string" && record.retryOfRunId.length > 0
        ? record.retryOfRunId
        : null,
    unresolvedBlockerIssueIds,
  };
}

export function buildSuppressedWakeParkMarker(input: {
  cause: SuppressedWakeParkCause;
  now: Date;
  unresolvedBlockerIssueIds?: string[];
  schedulingReason?: string | null;
  wakeReason?: string | null;
  idempotencyKey?: string | null;
  retryOfRunId?: string | null;
  /** Existing marker from the pair being refreshed; the original anchor stays. */
  previous?: SuppressedWakeParkMarker | null;
}): SuppressedWakeParkMarker {
  const nowIso = input.now.toISOString();
  if (input.previous) {
    return {
      cause: input.previous.cause,
      parkedAt: input.previous.parkedAt,
      lastSuppressedAt: nowIso,
      suppressions: input.previous.suppressions + 1,
      rechecks: input.previous.rechecks,
      wakeReason: input.previous.wakeReason ?? input.wakeReason ?? null,
      schedulingReason: input.previous.schedulingReason ?? null,
      idempotencyKey: input.previous.idempotencyKey ?? input.idempotencyKey ?? null,
      retryOfRunId: input.previous.retryOfRunId ?? input.retryOfRunId ?? null,
      unresolvedBlockerIssueIds:
        input.cause === "issue_dependencies_blocked" && input.unresolvedBlockerIssueIds
          ? input.unresolvedBlockerIssueIds
          : input.previous.unresolvedBlockerIssueIds,
    };
  }
  return {
    cause: input.cause,
    parkedAt: nowIso,
    lastSuppressedAt: nowIso,
    suppressions: 1,
    rechecks: 0,
    wakeReason: input.wakeReason ?? null,
    schedulingReason: input.schedulingReason ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    retryOfRunId: input.retryOfRunId ?? null,
    ...(input.unresolvedBlockerIssueIds
      ? { unresolvedBlockerIssueIds: input.unresolvedBlockerIssueIds }
      : {}),
  };
}

/**
 * Bumps only the recheck bookkeeping (promotion-time guard still held); the
 * original park anchor, suppression count and identity are preserved.
 */
export function rearmSuppressedWakeParkMarker(
  previous: SuppressedWakeParkMarker,
  now: Date,
): SuppressedWakeParkMarker {
  return {
    ...previous,
    lastSuppressedAt: now.toISOString(),
    rechecks: previous.rechecks + 1,
  };
}
