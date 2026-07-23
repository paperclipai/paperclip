import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { statusCards, statusCardUpdates } from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

interface TerminalGenerationIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

function failureReasonForIssue(issue: TerminalGenerationIssue) {
  const label = issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
  return issue.status === "cancelled"
    ? `Status-card generation task ${label} was cancelled before writing a summary.`
    : `Status-card generation task ${label} finished without writing a summary.`;
}

export async function finalizeStatusCardsForTerminalIssue(
  dbOrTx: Pick<Db, "update">,
  issue: TerminalGenerationIssue,
) {
  if (!TERMINAL_ISSUE_STATUSES.has(issue.status)) return [];

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
