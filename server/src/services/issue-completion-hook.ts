import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { runDependencyResolutionHook } from "./dependency-resolution-hook.js";
import type { heartbeatService } from "./heartbeat.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

/**
 * Finds the root CEO agent for a company (prefers reportsTo=null, falls back to any CEO).
 */
export async function findRootCeoAgent(
  db: Db,
  companyId: string,
): Promise<{ id: string; name: string } | null> {
  const candidates = await db
    .select({ id: agents.id, name: agents.name, reportsTo: agents.reportsTo })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.role, "ceo"),
        ne(agents.status, "terminated"),
      ),
    );
  return candidates.find((a) => a.reportsTo === null) ?? candidates[0] ?? null;
}

/**
 * Called after an issue is updated to `done`.
 * If the completed issue has a parentId, auto-reassigns the parent issue to
 * the company's root CEO agent (status → todo) so it can route next steps.
 * Also wakes the CEO with the comment ID for routing context.
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
  heartbeat?: HeartbeatService,
): Promise<void> {
  await runDependencyResolutionHook(db, completedIssue, heartbeat).catch((err) => {
    logger.error(
      { err, completedIssueId: completedIssue.id },
      "completion-hook: dependency resolution hook failed",
    );
  });

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
  const ceoAgent = await findRootCeoAgent(db, completedIssue.companyId);

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

    const [newComment] = await db
      .insert(issueComments)
      .values({
        issueId: parent.id,
        companyId: completedIssue.companyId,
        body: commentBody,
        authorAgentId: null,
        authorUserId: null,
      })
      .returning();

    if (heartbeat && newComment) {
      heartbeat
        .wakeup(ceoAgent.id, {
          source: "automation",
          triggerDetail: "system",
          reason: "subtask_completed",
          payload: { issueId: parent.id, commentId: newComment.id },
          requestedByActorType: "system",
          requestedByActorId: "completion_hook",
          contextSnapshot: {
            issueId: parent.id,
            taskId: parent.id,
            commentId: newComment.id,
            wakeCommentId: newComment.id,
            wakeReason: "subtask_completed",
            source: "completion_hook",
          },
        })
        .catch((err) =>
          logger.warn(
            { err, parentIssueId: parent.id, ceoAgentId: ceoAgent.id },
            "completion-hook: failed to wake CEO after subtask completion",
          ),
        );
    }

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
