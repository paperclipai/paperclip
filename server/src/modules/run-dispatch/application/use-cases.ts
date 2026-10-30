import { decideEarlyUpstreamReprobe } from "../domain/policy.js";
import type { UpstreamFailureEvidence, UpstreamRecoveryEvidence } from "../domain/policy.js";
import type { EarlyUpstreamReprobeCandidate, EarlyUpstreamReprobeCursor, RunDispatchWriter, ScheduledRetryReader, UpstreamReprobeScope } from "./ports.js";
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
const MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_PAGE = 50;

/**
 * Releases transient-upstream retries whose far-future pin (typically a
 * quota-reset hint) is stale because the upstream recovered early. A candidate
 * that the domain clears on same-agent, same-adapter recovery evidence has its pin pulled
 * forward to `now`, then flows through the same promotion path — and therefore
 * the same gates — as a retry that became due on its own.
 *
 * One invocation handles one bounded page. Event and startup callers continue
 * with nextCursor until the durable candidate set has been traversed.
 */
export function createPromoteEarlyUpstreamRecoveryRetries(deps: {
  reader: ScheduledRetryReader;
  writer: RunDispatchWriter;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
}) {
  return async function promoteEarlyUpstreamRecoveryRetries(input: {
    now?: Date;
    cutoff: Date | null;
    after?: EarlyUpstreamReprobeCursor | null;
    scope?: UpstreamReprobeScope;
  }) {
    const now = input.now ?? new Date();
    const runIds: string[] = [];
    const postCommitEffects: PostCommitEffect[] = [];
    const candidates: EarlyUpstreamReprobeCandidate[] = (
      await deps.reader.listEarlyUpstreamReprobeCandidates({
        now,
        cutoff: input.cutoff,
        limit: MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_PAGE,
        after: input.after ?? null,
        scope: input.scope,
      })
    ).slice(0, MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_PAGE);

    const last = candidates[candidates.length - 1];
    const nextCursor =
      candidates.length === MAX_EARLY_UPSTREAM_REPROBE_CANDIDATES_PER_PAGE && last?.scheduledRetryAt
        ? { scheduledRetryAt: last.scheduledRetryAt, createdAt: last.createdAt, runId: last.runId }
        : null;

    // Cache by the upstream scope, never by company alone: a green run from
    // another agent or adapter does not prove this agent's provider recovered.
    const upstreamStateByScope = new Map<string, {
      recoveryEvidence: UpstreamRecoveryEvidence | null;
      latestUpstreamFailure: UpstreamFailureEvidence | null;
    }>();
    for (const candidate of candidates) {
      if (!candidate.adapterType) continue;
      const scope = `${candidate.companyId}:${candidate.agentId}:${candidate.adapterType}`;
      let upstreamState = upstreamStateByScope.get(scope);
      if (!upstreamState) {
        const recoveryEvidence = await deps.reader.findUpstreamRecoveryEvidence({
          companyId: candidate.companyId,
          agentId: candidate.agentId,
          adapterType: candidate.adapterType,
          now,
        });
        // Only a failure at or after the success can outweigh it.
        const latestUpstreamFailure = recoveryEvidence
          ? await deps.reader.findLatestUpstreamFailure({
            companyId: candidate.companyId,
            agentId: candidate.agentId,
            adapterType: candidate.adapterType,
            since: recoveryEvidence.finishedAt,
          })
          : null;
        upstreamState = { recoveryEvidence, latestUpstreamFailure };
        upstreamStateByScope.set(scope, upstreamState);
      }

      const decision = decideEarlyUpstreamReprobe(
        {
          runId: candidate.runId,
          retryReason: candidate.retryReason,
          scheduledRetryAt: candidate.scheduledRetryAt,
          pinSetAt: candidate.pinSetAt,
          ...upstreamState,
        },
        now,
      );
      if (!decision.reprobe || !upstreamState.recoveryEvidence) continue;

      const advanced = await deps.writer.advanceScheduledRetryPin({
        runId: candidate.runId,
        companyId: candidate.companyId,
        agentId: candidate.agentId,
        adapterType: candidate.adapterType,
        now,
        originalScheduledRetryAt: candidate.scheduledRetryAt,
        evidenceRunId: decision.evidenceRunId,
        evidenceFinishedAt: upstreamState.recoveryEvidence.finishedAt,
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

    return { promoted: runIds.length, runIds, postCommitEffects, nextCursor };
  };
}

export function createPromoteDueScheduledRetries(deps: {
  reader: ScheduledRetryReader;
  promoteScheduledRetry: ReturnType<typeof createPromoteScheduledRetry>;
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
    reservationId: string;
    recoveryLeaseOwner?: string;
    enforceContinuationOwnership?: boolean;
    dispatch: (markDispatchStarted: () => void) => Promise<T>;
    now?: Date;
  }) => deps.writer.dispatchResolvedInteractionIfCurrent({
    ...input,
    now: input.now ?? new Date(),
  });
}
