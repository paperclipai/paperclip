/**
 * Database-aware enforcement of the same-root automatic-retry cap.
 *
 * {@link ./same-root-retry-cap.ts} defines the *pure* policy — how a retry root
 * and epoch are derived and when a `(root, epoch)` is exhausted. This module is
 * the single side-effecting gate every automatic retry/recovery mint point
 * calls before creating another run, so the cap is enforced identically no
 * matter which path (process-loss retry, stranded-issue recovery,
 * source-scoped recovery, …) mints the next run.
 *
 * Centralizing the count here is what closes the bypass the cap exists to stop:
 * each recovery path used to carry its own per-lineage counter, so a fresh run
 * id minted by a different path reset the limit and the chain retried forever
 * (see paperclipai/paperclip#9734, #7535). Here the count is taken over the
 * whole `(root, epoch)` regardless of which path created each run.
 *
 * The count and the caller's insert are made atomic with a transaction-scoped
 * advisory lock keyed on `(root, epoch)`: two recovery paths racing to recover
 * the same root serialize on the lock, so they cannot both read "3 runs" and
 * both mint a 4th. Callers that mint via a direct insert should pass the same
 * transaction they insert in; callers that mint through a higher-level wakeup
 * primitive should gate *before* minting (an exhausted root must not create
 * another run at all) and accept that the lock only spans the count.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  buildSameRootRetryPark,
  evaluateSameRootRetry,
  resolveRetryEpochForNewRun,
  resolveRetryRootRunId,
  type SameRootRetryPark,
} from "./same-root-retry-cap.js";

/** The subset of the source run the gate reads to derive the decision. */
export interface SameRootRetryGateSource {
  id: string;
  companyId: string;
  retryRootRunId: string | null;
  retryEpoch: number | null;
  /** Error code of the last failure, surfaced in the park descriptor. */
  errorCode?: string | null;
  /** Human-readable failure detail, surfaced in the park descriptor. */
  error?: string | null;
  /** Falls back to the park's next owner when none is supplied explicitly. */
  responsibleUserId?: string | null;
}

/**
 * Minimal executor shape shared by the top-level db handle and a transaction.
 * Passing a transaction makes the count atomic with the caller's insert.
 */
export type SameRootRetryExecutor = Pick<Db, "select" | "execute">;

export type SameRootRetryGateResult =
  | {
      allowed: true;
      retryRootRunId: string;
      retryEpoch: number;
      /** 1-based index of the retry the caller may now mint. */
      attempt: number;
    }
  | {
      allowed: false;
      retryRootRunId: string;
      retryEpoch: number;
      park: SameRootRetryPark;
    };

/**
 * Decide whether another automatic run may be minted for the source run's
 * `(root, epoch)`. Acquires a transaction advisory lock on that key, counts the
 * automatic runs already recorded for it, and applies {@link evaluateSameRootRetry}.
 *
 * The first (root) run of a lineage carries a null `retryRootRunId`, so it is
 * not matched by the count; the `+ 1` folds it back in, making the total
 * "first run + retries" exactly as the pure policy expects.
 */
export async function enforceSameRootRetryCap(
  exec: SameRootRetryExecutor,
  input: {
    source: SameRootRetryGateSource;
    wakeReason: string | null | undefined;
    nextOwner?: string | null;
  },
): Promise<SameRootRetryGateResult> {
  const retryRootRunId = resolveRetryRootRunId(input.source);
  const retryEpoch = resolveRetryEpochForNewRun({ source: input.source, wakeReason: input.wakeReason });

  // Serialize concurrent minters for this (root, epoch) so the count → decide →
  // insert window is atomic. Released automatically when the surrounding
  // transaction ends; on the top-level handle it spans just this statement, so
  // atomicity there relies on the caller gating before it mints.
  await exec.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${retryRootRunId}:${retryEpoch}`}, 0))`);

  const priorAutomaticRunCount = await exec
    .select({ value: count() })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.source.companyId),
        eq(heartbeatRuns.retryRootRunId, retryRootRunId),
        eq(heartbeatRuns.retryEpoch, retryEpoch),
      ),
    )
    .then((rows) => rows[0]?.value ?? 0);

  const decision = evaluateSameRootRetry({ priorAutomaticRunCount: priorAutomaticRunCount + 1 });
  if (decision.allowed) {
    return { allowed: true, retryRootRunId, retryEpoch, attempt: decision.attempt };
  }

  const park = buildSameRootRetryPark({
    rootRunId: retryRootRunId,
    epoch: retryEpoch,
    attempt: decision.attempt,
    maxRetries: decision.maxRetries,
    lastErrorCode: input.source.errorCode ?? null,
    lastErrorMessage: input.source.error ?? null,
    nextOwner: input.nextOwner ?? input.source.responsibleUserId ?? null,
  });
  return { allowed: false, retryRootRunId, retryEpoch, park };
}
