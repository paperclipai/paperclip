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

export async function finalizeStatusCardsForStalledGeneration(
  dbOrTx: Pick<Db, "update">,
  issue: StalledGenerationIssue,
) {
  if (!STALLED_GENERATION_STATUSES.has(issue.status)) return [];

  const now = new Date();
  const failureReason = failureReasonForIssue(issue);
  const cards = await dbOrTx
    .update(statusCards)
    .set({
      state: "error",
      failureReason,
      generatingIssueId: null,
      nextEvalAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(statusCards.companyId, issue.companyId),
        eq(statusCards.generatingIssueId, issue.id),
      ),
    )
    .returning({ id: statusCards.id });

  await dbOrTx
    .update(statusCardUpdates)
    .set({
      status: "failed",
      error: failureReason,
      finishedAt: now,
    })
    .where(
      and(
        eq(statusCardUpdates.generationIssueId, issue.id),
        isNull(statusCardUpdates.finishedAt),
      ),
    );

  return cards;
}
