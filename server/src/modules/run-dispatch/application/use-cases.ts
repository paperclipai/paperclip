import type { RunDispatchWriter, ScheduledRetryReader } from "./ports.js";
import type { PostCommitEffect, PromoteScheduledRetryOutcome } from "./types.js";
import { planDueQuotaRecoveryReleases } from "../domain/quota-recovery-release.js";

export function createEvaluateScheduledRetryGate(deps: { reader: ScheduledRetryReader }) {
  return (input: {
    runId: string;
    companyId: string;
    retryReasonOverride: string;
    now?: Date;
  }) => deps.reader.evaluateScheduledRetryGate({ ...input, now: input.now ?? new Date() });
}

export function createPromoteScheduledRetry(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    now?: Date;
  }): Promise<PromoteScheduledRetryOutcome> =>
    deps.writer.promoteOrCancelDueRetry({
      runId: input.runId,
      companyId: input.companyId,
      now: input.now ?? new Date(),
    });
}

const MAX_DUE_RETRIES_PER_SWEEP = 50;

/**
 * Promotes every due `scheduled_retry` row a sweep reads, with two bounds on
 * `provider_quota_recovery` rows only.
 *
 * The sweep used to promote all of its candidates in one pass. A single
 * upstream 429 wave parks one recovery row per affected issue, and promoting
 * the whole wave at once pushes the queue full of quota retries ahead of the
 * real work those agents still owe, even though execution itself is already
 * serialised by `maxConcurrentRuns`. Rows whose reason belongs to a different
 * mechanism are promoted exactly as before.
 *
 * A planner failure denies the quota-recovery releases for this sweep and
 * leaves every other row on its existing path.
 */
export function createPromoteDueScheduledRetries(deps: {
  reader: ScheduledRetryReader;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
  deferScheduledRetry: RunDispatchWriter["deferScheduledRetry"];
  now?: () => Date;
  planSeed?: (now: Date) => number;
}) {
  const clock = deps.now ?? (() => new Date());
  // Derives the sweep's jitter seed from the instant it runs at, so a replay of
  // the same sweep produces the same plan without threading a seed through
  // every caller.
  const seedFor = deps.planSeed ?? ((now: Date) => now.getTime());

  return async function promoteDueScheduledRetries(input: { now?: Date; cutoff: Date | null }) {
    const now = input.now ?? clock();
    const dueRuns = (
      await deps.reader.listDueRetries({ now, cutoff: input.cutoff, limit: MAX_DUE_RETRIES_PER_SWEEP })
    ).slice(0, MAX_DUE_RETRIES_PER_SWEEP);
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];

    // An unreadable in-flight count is not an error to swallow into "nothing is
    // running": it is the one input the cap cannot do without, so the planner
    // gets null and denies the quota-recovery rows for this sweep.
    const inflightByAgent = await deps.reader
      .countInflightQuotaRecoveryRetries()
      .catch(() => null);
    const plan = planDueQuotaRecoveryReleases({
      due: dueRuns.map((run) => ({
        runId: run.runId,
        agentId: run.agentId,
        scheduledRetryAt: run.scheduledRetryAt,
        scheduledRetryReason: run.scheduledRetryReason,
      })),
      now,
      inflightByAgent,
      seed: seedFor(now),
    });

    for (const decision of plan.decisions) {
      const dueRun = dueRuns.find((run) => run.runId === decision.runId);
      if (!dueRun) continue;

      // An out-of-scope row belongs to another mechanism, and a deferred row
      // that was denied (not rescheduled) stays parked on its own due time.
      // Neither is promoted and neither is rescheduled.
      if (decision.outcome === "deferred" && !decision.outOfScope) {
        if (decision.releaseAt) {
          await deps.deferScheduledRetry({
            runId: decision.runId,
            companyId: dueRun.companyId,
            scheduledRetryAt: decision.releaseAt,
            now,
          });
        }
        continue;
      }

      const result = await deps.promoteScheduledRetry({
        runId: dueRun.runId,
        companyId: dueRun.companyId,
        now,
      });
      if (result.outcome !== "promoted") continue;
      runIds.push(dueRun.runId);
      postCommitEffects.push(...result.postCommitEffects);
    }

    return {
      promoted: runIds.length,
      runIds,
      postCommitEffects,
      releasePlan: plan,
    };
  };
}

export function createCancelStaleQueuedRun(deps: { writer: RunDispatchWriter }) {
  return (input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    now?: Date;
  }) => deps.writer.cancelStaleQueuedRun({ ...input, now: input.now ?? new Date() });
}

export function createDispatchResolvedInteractionIfCurrent(deps: { writer: RunDispatchWriter }) {
  return <T>(input: {
    runId: string;
    companyId: string;
    expectedStatus: "queued" | "running";
    dispatch: (markDispatchStarted: () => void) => Promise<T>;
    now?: Date;
  }) => deps.writer.dispatchResolvedInteractionIfCurrent({
    ...input,
    now: input.now ?? new Date(),
  });
}
