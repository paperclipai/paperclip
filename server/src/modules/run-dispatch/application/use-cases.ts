import { decideEarlyUpstreamReprobe } from "../domain/policy.js";
import type { UpstreamRecoveryEvidence } from "../domain/policy.js";
import type { EarlyUpstreamReprobeCandidate, EarlyUpstreamReprobeCursor, RunDispatchWriter, ScheduledRetryReader } from "./ports.js";
import type { PostCommitEffect, PromoteScheduledRetryOutcome } from "./types.js";

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
const MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_SWEEP = 50;

/**
 * Releases transient-upstream retries whose far-future pin (typically a
 * quota-reset hint) is stale because the upstream recovered early. A candidate
 * that the domain clears on same-agent, same-adapter recovery evidence has its pin pulled
 * forward to `now`, then flows through the same promotion path — and therefore
 * the same gates — as a retry that became due on its own.
 *
 * Each sweep reads one bounded page of candidates. The cursor carries the walk
 * across sweeps and wraps to the start after a short page, so every candidate
 * is re-checked within ceil(candidates / page) sweeps while no single sweep
 * does more than one page of work.
 */
export function createPromoteEarlyUpstreamRecoveryRetries(deps: {
  reader: ScheduledRetryReader;
  writer: RunDispatchWriter;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
}) {
  let after: EarlyUpstreamReprobeCursor | null = null;

  return async function promoteEarlyUpstreamRecoveryRetries(input: {
    now?: Date;
    cutoff: Date | null;
    /** Runs the caller already promoted on the due path this sweep. */
    skipRunIds?: ReadonlySet<string>;
  }) {
    const now = input.now ?? new Date();
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];
    const candidates: EarlyUpstreamReprobeCandidate[] = (
      await deps.reader.listEarlyUpstreamReprobeCandidates({
        now,
        cutoff: input.cutoff,
        limit: MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_SWEEP,
        after,
      })
    ).slice(0, MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_SWEEP);

    // Move the cursor before any candidate is processed: an overlapping sweep
    // reads the next page, and a candidate that throws cannot hold the walk on
    // its page.
    const last = candidates[candidates.length - 1];
    after =
      candidates.length === MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_SWEEP && last?.scheduledRetryAt
        ? { scheduledRetryAt: last.scheduledRetryAt, createdAt: last.createdAt, runId: last.runId }
        : null;

    // Cache by the upstream scope, never by company alone: a green run from
    // another agent or adapter does not prove this agent's provider recovered.
    const evidenceByScope = new Map<string, UpstreamRecoveryEvidence | null>();
    for (const candidate of candidates) {
      if (input.skipRunIds?.has(candidate.runId) || !candidate.adapterType) continue;
      const scope = `${candidate.companyId}:${candidate.agentId}:${candidate.adapterType}`;
      if (!evidenceByScope.has(scope)) {
        evidenceByScope.set(scope, await deps.reader.findUpstreamRecoveryEvidence({
          companyId: candidate.companyId,
          agentId: candidate.agentId,
          adapterType: candidate.adapterType,
          now,
        }));
      }

      const decision = decideEarlyUpstreamReprobe(
        {
          runId: candidate.runId,
          retryReason: candidate.retryReason,
          scheduledRetryAt: candidate.scheduledRetryAt,
          pinSetAt: candidate.pinSetAt,
          recoveryEvidence: evidenceByScope.get(scope) ?? null,
        },
        now,
      );
      if (!decision.reprobe) continue;

      const advanced = await deps.writer.advanceScheduledRetryPin({
        runId: candidate.runId,
        companyId: candidate.companyId,
        now,
        originalScheduledRetryAt: candidate.scheduledRetryAt,
        evidenceRunId: decision.evidenceRunId,
      });
      if (!advanced.advanced) continue;

      const result = await deps.promoteScheduledRetry({
        runId: candidate.runId,
        companyId: candidate.companyId,
        now,
      });
      if (result.outcome !== "promoted") continue;
      runIds.push(candidate.runId);
      postCommitEffects.push(...result.postCommitEffects);
    }

    return { promoted: runIds.length, runIds, postCommitEffects };
  };
}

export function createPromoteDueScheduledRetries(deps: {
  reader: ScheduledRetryReader;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
  promoteEarlyUpstreamRecoveryRetries: ReturnType<
    typeof createPromoteEarlyUpstreamRecoveryRetries
  >;
}) {
  return async function promoteDueScheduledRetries(input: { now?: Date; cutoff: Date | null }) {
    const now = input.now ?? new Date();
    const dueRuns = (
      await deps.reader.listDueRetries({ now, cutoff: input.cutoff, limit: MAX_DUE_RETRIES_PER_SWEEP })
    ).slice(0, MAX_DUE_RETRIES_PER_SWEEP);
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];

    for (const dueRun of dueRuns) {
      const result = await deps.promoteScheduledRetry({ ...dueRun, now });
      if (result.outcome !== "promoted") continue;
      runIds.push(dueRun.runId);
      postCommitEffects.push(...result.postCommitEffects);
    }

    // Beyond the runs whose pin came due on its own, release the ones still
    // pinned to an outage that has demonstrably ended.
    const earlyReprobed = await deps.promoteEarlyUpstreamRecoveryRetries({
      now,
      cutoff: input.cutoff,
      skipRunIds: new Set(dueRuns.map((dueRun) => dueRun.runId)),
    });
    runIds.push(...earlyReprobed.runIds);
    postCommitEffects.push(...earlyReprobed.postCommitEffects);

    return { promoted: runIds.length, runIds, postCommitEffects };
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
