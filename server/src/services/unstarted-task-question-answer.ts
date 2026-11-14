import { and, eq, isNull } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

/**
 * A question that no run asked, such as the onboarding opening card, can be
 * answered before its task has ever started. Answer continuations normally
 * require in_progress or in_review so an operator who parked the task wins.
 * A todo task that has never started has no parked execution to protect, so
 * its answer may check the task out from todo.
 *
 * Reads only server-owned rows: the interaction must be an answered question
 * on this task with no source run, and the task must still be todo with no
 * startedAt. Confirmations and other interaction kinds keep the stricter rule.
 */
export async function isUnstartedTaskQuestionAnswer(
  db: Db,
  input: { companyId: string; issueId: string; interactionId: unknown },
): Promise<boolean> {
  const interactionId = typeof input.interactionId === "string" ? input.interactionId : null;
  if (!interactionId || !isUuidLike(interactionId)) return false;
  const rows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.kind, "ask_user_questions"),
      eq(issueThreadInteractions.status, "answered"),
      isNull(issueThreadInteractions.sourceRunId),
      eq(issues.status, "todo"),
      isNull(issues.startedAt),
    ))
    .limit(1);
  return rows.length > 0;
}
