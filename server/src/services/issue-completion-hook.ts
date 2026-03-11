import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

/**
 * Called after an issue is updated to `done`.
 * If the completed issue has a parentId, auto-reassigns the parent issue to
 * the company's root CEO agent (status → todo) so it can route next steps.
 * Non-fatal: logs failures without throwing.
 */
export async function runCompletionHook(
  db: Db,
  completedIssue: {
    id: string;
    identifier: string | null;
    title: string;
    companyId: string;
    parentId: string | null;
  },
): Promise<void> {
  if (!completedIssue.parentId) return;

  const parent = await db
    .select()
    .from(issues)
    .where(eq(issues.id, completedIssue.parentId))
    .then((rows) => rows[0] ?? null);

  if (!parent) {
    logger.warn(
      { issueId: completedIssue.id, parentId: completedIssue.parentId },
      "completion-hook: parent issue not found, skipping",
    );
    return;
  }

  // Skip if parent is already in a terminal state
  if (parent.status === "done" || parent.status === "cancelled") return;

  // Find root CEO agent in the company (prefer reportsTo=null, fall back to any CEO)
  const ceoCandidates = await db
    .select({ id: agents.id, name: agents.name, reportsTo: agents.reportsTo })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, completedIssue.companyId),
        eq(agents.role, "ceo"),
        ne(agents.status, "terminated"),
      ),
    );

  const ceoAgent =
    ceoCandidates.find((a) => a.reportsTo === null) ?? ceoCandidates[0] ?? null;

  if (!ceoAgent) {
    logger.warn(
      { companyId: completedIssue.companyId, parentId: parent.id },
      "completion-hook: no CEO agent found, skipping parent reassignment",
    );
    return;
  }

  try {
    const identifier = completedIssue.identifier ?? completedIssue.id;
    const companyPrefix = identifier.includes("-") ? identifier.split("-")[0] : null;
    const subtaskLink = companyPrefix
      ? `[${identifier}](/${companyPrefix}/issues/${identifier})`
      : identifier;
    const commentBody =
      `Subtask ${subtaskLink} — **${completedIssue.title}** — has been marked done.\n\n` +
      `Routing this parent issue back to you for next-step coordination.`;

    await db
      .update(issues)
      .set({
        assigneeAgentId: ceoAgent.id,
        assigneeUserId: null,
        status: "todo",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, parent.id));

    await db.insert(issueComments).values({
      issueId: parent.id,
      companyId: completedIssue.companyId,
      body: commentBody,
      authorAgentId: null,
      authorUserId: null,
    });

    await logActivity(db, {
      companyId: completedIssue.companyId,
      actorType: "system",
      actorId: "completion_hook",
      action: "issue.updated",
      entityType: "issue",
      entityId: parent.id,
      details: {
        identifier: parent.identifier,
        status: "todo",
        assigneeAgentId: ceoAgent.id,
        _previous: {
          status: parent.status,
          assigneeAgentId: parent.assigneeAgentId,
        },
        source: "completion_hook",
        triggeredByIssueId: completedIssue.id,
        triggeredByIdentifier: completedIssue.identifier,
      },
    });

    logger.info(
      {
        completedIssueId: completedIssue.id,
        parentIssueId: parent.id,
        ceoAgentId: ceoAgent.id,
      },
      "completion-hook: parent reassigned to CEO",
    );
  } catch (err) {
    logger.error(
      { err, completedIssueId: completedIssue.id, parentIssueId: parent.id },
      "completion-hook: failed to reassign parent",
    );
    await logActivity(db, {
      companyId: completedIssue.companyId,
      actorType: "system",
      actorId: "completion_hook",
      action: "issue.updated",
      entityType: "issue",
      entityId: parent.id,
      details: {
        source: "completion_hook",
        error: err instanceof Error ? err.message : String(err),
        triggeredByIssueId: completedIssue.id,
      },
    }).catch(() => {});
  }
}
