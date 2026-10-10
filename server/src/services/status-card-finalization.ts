import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { statusCards, statusCardUpdates } from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";

// A status-card generation run stops making progress when its task reaches one
// of these statuses. `done`/`cancelled` are terminal; `blocked` is not, but a
// blocked setup/update task is stuck awaiting human help and will never write a
// summary on its own — so we release the card's `generatingIssueId` claim in all
// three cases. The board tile keys "run in flight" off `generatingIssueId`, so
// clearing it here is what flips a wedged card back to offering "Run now".
const STALLED_GENERATION_STATUSES = new Set<IssueStatus>(["done", "cancelled", "blocked"]);

interface StalledGenerationIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

function failureReasonForIssue(issue: StalledGenerationIssue) {
  const label = issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
  if (issue.status === "cancelled") {
    return `Status-card generation task ${label} was cancelled before writing a summary.`;
  }
  if (issue.status === "blocked") {
    return `Status-card generation task ${label} was blocked before writing a summary; re-run to retry.`;
  }
  return `Status-card generation task ${label} finished without writing a summary.`;
}

/**
 * Release a card's generation claim and close its ledger row as failed.
 *
 * The card keys "run in flight" off `generatingIssueId`, so clearing it is what
 * returns the card to the scheduler's due list and to the board tile's "Run now".
 * `cardId` fences the update on one specific card, so a reap that lost a race to
 * a newer claim becomes a no-op instead of releasing the newer claim.
 */
async function releaseGenerationClaim(
  dbOrTx: Pick<Db, "update">,
  input: {
    issueId: string;
    companyId: string;
    cardId?: string;
    failureReason: string;
    nextEvalAt: Date | null;
  },
) {
  const now = new Date();
  const cards = await dbOrTx
    .update(statusCards)
    .set({
      state: "error",
      failureReason: input.failureReason,
      generatingIssueId: null,
      nextEvalAt: input.nextEvalAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(statusCards.companyId, input.companyId),
        ...(input.cardId ? [eq(statusCards.id, input.cardId)] : []),
        eq(statusCards.generatingIssueId, input.issueId),
      ),
    )
    .returning({ id: statusCards.id });
  if (cards.length === 0) return [];

  await dbOrTx
    .update(statusCardUpdates)
    .set({
      status: "failed",
      error: input.failureReason,
      finishedAt: now,
    })
    .where(
      and(
        eq(statusCardUpdates.generationIssueId, input.issueId),
        isNull(statusCardUpdates.finishedAt),
      ),
    );

  return cards;
}

export async function finalizeStatusCardsForStalledGeneration(
  dbOrTx: Pick<Db, "update">,
  issue: StalledGenerationIssue,
) {
  if (!STALLED_GENERATION_STATUSES.has(issue.status)) return [];
  return releaseGenerationClaim(dbOrTx, {
    issueId: issue.id,
    companyId: issue.companyId,
    failureReason: failureReasonForIssue(issue),
    nextEvalAt: null,
  });
}

export const STALE_GENERATION_FAILURE_REASON =
  "Status-card generation task stopped reporting progress before writing a summary; the claim was released and the card will refresh on its next scheduled evaluation.";

/**
 * Release a generation claim that never produced a summary while its task was
 * still nominally in flight.
 *
 * The stalled-status path above cannot see this case. The task is left `todo` or
 * `in_progress` because the run that was meant to drive it died — a wake that was
 * enqueued and then failed, a run that crashed, an adapter that went away. That
 * task is created hidden, and `hiddenAt IS NULL` is what the owner's timer
 * heartbeat selects on, so the task is unreachable by construction: nothing
 * retries the wake, nothing moves the task, and the card keeps its
 * `generatingIssueId` claim while every later scheduler tick skips it. The card
 * reads healthy while its refresh is dead.
 *
 * Releasing the claim puts the card back in the scheduler's due list. The caller
 * supplies `nextEvalAt` so the retry lands on the card's normal cadence rather
 * than immediately, because a cause that persists (a broken summarizer lane, say)
 * must not become a per-tick retry loop.
 */
export async function finalizeStaleStatusCardClaim(
  dbOrTx: Pick<Db, "update">,
  input: {
    cardId: string;
    companyId: string;
    generatingIssueId: string;
    nextEvalAt: Date | null;
  },
) {
  return releaseGenerationClaim(dbOrTx, {
    issueId: input.generatingIssueId,
    companyId: input.companyId,
    cardId: input.cardId,
    failureReason: STALE_GENERATION_FAILURE_REASON,
    nextEvalAt: input.nextEvalAt,
  });
}
