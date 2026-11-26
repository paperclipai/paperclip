import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { summarySlots } from "@paperclipai/db";
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
    ? `Summary generation task ${label} was cancelled before writing a summary.`
    : `Summary generation task ${label} finished without writing a summary.`;
}

export async function finalizeSummarySlotsForTerminalIssue(
  dbOrTx: Pick<Db, "update">,
  issue: TerminalGenerationIssue,
) {
  if (!TERMINAL_ISSUE_STATUSES.has(issue.status)) return [];

  return dbOrTx
    .update(summarySlots)
    .set({
      status: "failed",
      failureReason: failureReasonForIssue(issue),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(summarySlots.companyId, issue.companyId),
        eq(summarySlots.generatingIssueId, issue.id),
        eq(summarySlots.status, "generating"),
      ),
    )
    .returning({ id: summarySlots.id });
}
