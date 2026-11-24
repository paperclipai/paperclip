// Pure decision rules for releasing due provider-quota-recovery retries.
//
// A retry parked with `scheduledRetryReason = "provider_quota_recovery"` is
// work the control plane already decided to redo once an inference quota
// window opened. How that work is handed back has one problem.
//
// `createPromoteDueScheduledRetries` promotes every row a sweep reads,
// company-wide, in one pass. A single upstream 429 wave parks one recovery row
// per affected issue, so the next sweep promotes the whole wave into the shared
// `queued` pool at once. Execution is already serialised per agent by
// `maxConcurrentRuns`, so this is not a burst of concurrent runs -- it is a
// queue-depth problem: the promoted retries occupy the slots ahead of the real
// work those agents still owe, and the wave drains in `maxConcurrentRuns`
// sized instalments regardless of whether the quota window is still open.
//
// The correlated due times that produce the wave are fixed where they are
// created, not here: `readProviderQuotaRetryAt` in
// `services/recovery/service.ts` used to compute a flat
// `now + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS`, so every retry enqueued
// during one incident came due at the same instant one hour later. See
// `decorrelateRetryAt` for that half, and note that it needs `now` to be the
// enqueue instant, which is why it cannot live in this planner.
//
// Rows whose retry reason belongs to another mechanism are not this planner's
// business: they are reported and released on their existing path, never
// admitted against the cap and never held by it.
//
// Pure: no database, no clock, no ambient randomness. `now` and `seed` are
// arguments, so identical inputs produce an identical plan and a plan can be
// regression-tested.

/** The one retry reason this planner governs. */
export const QUOTA_RECOVERY_RETRY_REASON = "provider_quota_recovery";

/** Quota-recovery releases admitted per agent per sweep. */
export const DEFAULT_QUOTA_RECOVERY_CAP_PER_AGENT = 1;
/** How far past the sweep an over-cap retry is pushed, per ordinal. */
export const DEFAULT_QUOTA_RECOVERY_DEFERRAL_STEP_MS = 60_000;
/** Extra offset added to a flat backoff so a cohort does not land together. */
export const DEFAULT_QUOTA_RECOVERY_DECORRELATION_WINDOW_MS = 30 * 60_000;

export type ReleaseOutcome = "released" | "deferred";

/**
 * Closed vocabulary. Every non-release names one of these, so a log line that
 * reports nothing released also says why, without free-text interpretation.
 */
export const RELEASE_REASON_INFLIGHT_UNAVAILABLE = "inflight_state_unavailable";
export const RELEASE_REASON_OVER_CAP = "per_agent_cap_reached";
export const RELEASE_REASON_RELEASED = "admitted_within_cap";
export const RELEASE_REASON_OUT_OF_SCOPE = "not_quota_recovery_retry";

/** One due retry row, as the sweep read it. */
export type DueQuotaRetry = {
  runId: string;
  agentId: string;
  scheduledRetryAt: Date;
  scheduledRetryReason: string | null;
};

export type ReleaseDecision = {
  runId: string;
  agentId: string;
  outcome: ReleaseOutcome;
  reason: string;
  /**
   * The new due time for a deferred row, or null when the row is left on its
   * own due time. Out-of-scope rows and rows denied for a degraded plan are
   * left where they are rather than rescheduled onto a fabricated instant.
   */
  releaseAt: Date | null;
  /**
   * True when the row's reason is not `provider_quota_recovery`. Out-of-scope
   * rows are reported here and promoted by the caller on its existing path.
   */
  outOfScope: boolean;
};

export type AgentReleaseState = {
  agentId: string;
  cap: number;
  /** -1 when in-flight state was unavailable. */
  inflight: number;
  /** In-scope rows this sweep read for the agent. */
  due: number;
  released: number;
  deferred: number;
};

export type QuotaRecoveryReleaseReport = {
  now: Date;
  capPerAgent: number;
  /** True when in-flight state was unavailable and in-scope rows were denied. */
  degraded: boolean;
  decisions: ReleaseDecision[];
  agents: AgentReleaseState[];
};

export type ReleasePlan = QuotaRecoveryReleaseReport & {
  released: ReleaseDecision[];
  deferred: ReleaseDecision[];
  decision(runId: string): ReleaseDecision | undefined;
};

/** FNV-1a, 32-bit: deterministic across processes and platforms, unlike a
 * language hash whose seed is randomised per run. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A reproducible uniform value in [0, 1) for one key.
 *
 * Both `seed` and `key` are required, so no caller can accidentally get a
 * spread that changes between runs and cannot be asserted on.
 */
function uniformFor(seed: number, key: string): number {
  // mulberry32, one step from a hashed seed.
  let state = (fnv1a32(`${seed}:${key}`) || 1) >>> 0;
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function inScope(retry: DueQuotaRetry): boolean {
  return retry.scheduledRetryReason === QUOTA_RECOVERY_RETRY_REASON;
}

export type PlanDueQuotaRecoveryReleasesInput = {
  /** Candidates. Not assumed in scope; that is decided here from the row's own
   * reason rather than assumed by the caller. */
  due: DueQuotaRetry[];
  /** The sweep instant. Injected, never read from a clock. */
  now: Date;
  /**
   * Per-agent count of quota-recovery retries already released and not yet
   * finished. `null` is *unknown*, and unknown releases nothing.
   */
  inflightByAgent: ReadonlyMap<string, number> | null;
  /** Reserved for reproducibility of future clock-dependent rules; today's
   * decisions do not depend on it. */
  seed: number;
  capPerAgent?: number;
  deferralStepMs?: number;
};

/**
 * Decides which due quota-recovery retries may leave the queue this sweep.
 *
 * Fail-closed: `inflightByAgent === null` denies every in-scope retry and marks
 * the plan `degraded`. Assuming zero in flight under an unreadable input would
 * admit releases precisely when the control plane is already unhealthy, which
 * is the only moment a cap matters. The denial is a return value carrying a
 * reason, not a thrown error, and the denied rows keep their own due time so a
 * later sweep re-decides them.
 */
export function planDueQuotaRecoveryReleases(
  input: PlanDueQuotaRecoveryReleasesInput,
): ReleasePlan {
  const capPerAgent = input.capPerAgent ?? DEFAULT_QUOTA_RECOVERY_CAP_PER_AGENT;
  const deferralStepMs = input.deferralStepMs ?? DEFAULT_QUOTA_RECOVERY_DEFERRAL_STEP_MS;
  if (!Number.isInteger(capPerAgent) || capPerAgent < 1) {
    throw new RangeError(
      "capPerAgent must be an integer >= 1; a cap of 0 would deny every retry forever",
    );
  }
  if (deferralStepMs <= 0) {
    throw new RangeError("deferralStepMs must be > 0");
  }

  const now = input.now;
  const degraded = input.inflightByAgent === null;
  // The caller's order is preserved, not re-sorted. It already arrives as
  // `scheduledRetryAt, createdAt, id`, so it is deterministic, and re-sorting
  // here would change which run is promoted first when two rows are due at the
  // same instant -- an unrelated behaviour change dressed up as tidiness.
  const candidates = [...input.due];

  const byAgent = new Map<string, DueQuotaRetry[]>();
  for (const retry of candidates) {
    const bucket = byAgent.get(retry.agentId);
    if (bucket) bucket.push(retry);
    else byAgent.set(retry.agentId, [retry]);
  }
  const agentIds = [...byAgent.keys()].sort();

  const decisions = new Map<string, ReleaseDecision>();
  const agents: AgentReleaseState[] = [];

  for (const agentId of agentIds) {
    const retries = byAgent.get(agentId)!;
    const scope = retries.filter(inScope);
    const inflight = degraded
      ? -1
      : Math.max(0, input.inflightByAgent!.get(agentId) ?? 0);
    const room = degraded ? 0 : Math.max(0, capPerAgent - inflight);
    const admitted = scope.slice(0, room);

    let released = 0;
    let deferred = 0;
    let ordinal = 0;

    for (const retry of retries) {
      let decision: ReleaseDecision;
      if (!inScope(retry)) {
        // Another mechanism's retry: reported so it stays visible, promoted by
        // the caller on its existing path. It never consumes cap and is never
        // held here, because a cap that silently delays process-loss recovery
        // would trade a visible queue-depth problem for an invisible one.
        decision = {
          runId: retry.runId,
          agentId,
          outcome: "deferred",
          reason: RELEASE_REASON_OUT_OF_SCOPE,
          releaseAt: null,
          outOfScope: true,
        };
        deferred += 1;
      } else if (admitted.includes(retry)) {
        decision = {
          runId: retry.runId,
          agentId,
          outcome: "released",
          reason: RELEASE_REASON_RELEASED,
          releaseAt: now,
          outOfScope: false,
        };
        released += 1;
      } else if (degraded) {
        decision = {
          runId: retry.runId,
          agentId,
          outcome: "deferred",
          reason: RELEASE_REASON_INFLIGHT_UNAVAILABLE,
          releaseAt: null,
          outOfScope: false,
        };
        deferred += 1;
      } else {
        decision = {
          runId: retry.runId,
          agentId,
          outcome: "deferred",
          reason: RELEASE_REASON_OVER_CAP,
          releaseAt: new Date(now.getTime() + deferralStepMs * (ordinal + 1)),
          outOfScope: false,
        };
        ordinal += 1;
        deferred += 1;
      }
      decisions.set(retry.runId, decision);
    }

    agents.push({
      agentId,
      cap: capPerAgent,
      inflight,
      due: scope.length,
      released,
      deferred,
    });
  }

  const ordered = candidates
    .map((retry) => decisions.get(retry.runId))
    .filter((decision): decision is ReleaseDecision => decision !== undefined);
  const report: QuotaRecoveryReleaseReport = {
    now,
    capPerAgent,
    degraded,
    decisions: ordered,
    agents,
  };
  return {
    ...report,
    released: ordered.filter((d) => d.outcome === "released"),
    deferred: ordered.filter((d) => d.outcome === "deferred"),
    decision: (runId: string) => decisions.get(runId),
  };
}

/**
 * Proposes a *spread* `retryAt` for a retry being enqueued.
 *
 * The flat `createdAt + baseBackoff` offset re-synchronises the cohort it just
 * de-synchronised: every retry created during one outage shares a due time one
 * base-backoff later, so a single 429 wave comes back as a single wave. This
 * proposes `createdAt + baseBackoff + U(0, windowMs)`, keeping the base
 * backoff as a floor so the spread can only delay a retry, and keying the draw
 * on `cohortKey` so the same cohort gets the same spread across restarts.
 *
 * This is a keyed draw rather than a stratified schedule, because the cohort
 * size is not known when a single row is enqueued. Two cohorts inside one
 * window can therefore land close together; the release-side
 * `planDueQuotaRecoveryReleases` cap is what bounds the result if they do.
 */
export function decorrelateRetryAt(input: {
  now: Date;
  baseBackoffMs: number;
  windowMs?: number;
  minBackoffMs?: number;
  seed: number;
  cohortKey: string;
}): Date {
  const windowMs = input.windowMs ?? DEFAULT_QUOTA_RECOVERY_DECORRELATION_WINDOW_MS;
  const minBackoffMs = input.minBackoffMs ?? 1_000;
  if (input.baseBackoffMs < minBackoffMs) {
    throw new RangeError(
      "baseBackoffMs must be >= minBackoffMs; a retry due before it was created is a bug, not a policy",
    );
  }
  if (windowMs < 0) {
    throw new RangeError("windowMs must be >= 0");
  }
  const offset = Math.floor(uniformFor(input.seed, `retry-at:${input.cohortKey}`) * (windowMs + 1));
  return new Date(input.now.getTime() + input.baseBackoffMs + offset);
}
