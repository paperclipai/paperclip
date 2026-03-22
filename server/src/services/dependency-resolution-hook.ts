import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issueDependencies, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

async function findRootCeoAgent(
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

  return candidates.find((agent) => agent.reportsTo === null) ?? candidates[0] ?? null;
}

function issueLink(identifier: string | null, id: string) {
  if (!identifier || !identifier.includes("-")) return identifier ?? id;
  const prefix = identifier.split("-")[0];
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

export async function runDependencyResolutionHook(
  db: Db,
  completedIssue: {
    id: string;
    identifier: string | null;
    companyId: string;
  },
  heartbeat?: HeartbeatService,
): Promise<void> {
  const resolvedAt = new Date();
  const resolvedDeps = await db
    .update(issueDependencies)
    .set({ resolvedAt })
    .where(
      and(
        eq(issueDependencies.companyId, completedIssue.companyId),
        eq(issueDependencies.blockingIssueId, completedIssue.id),
        isNull(issueDependencies.resolvedAt),
      ),
    )
    .returning({
      id: issueDependencies.id,
      blockedIssueId: issueDependencies.blockedIssueId,
      blockingIssueId: issueDependencies.blockingIssueId,
    });

  if (resolvedDeps.length === 0) return;

  const affectedIssueIds = [...new Set(resolvedDeps.map((dep) => dep.blockedIssueId))];
  const affectedIssues = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, completedIssue.companyId),
        inArray(issues.id, affectedIssueIds),
      ),
    );

  const issueById = new Map(affectedIssues.map((row) => [row.id, row]));
  for (const blockedIssueId of affectedIssueIds) {
    const blockedIssue = issueById.get(blockedIssueId);
    if (!blockedIssue) continue;
    if (blockedIssue.status !== "blocked") continue;

    const unresolvedDeps = await db
      .select({ id: issueDependencies.id })
      .from(issueDependencies)
      .where(
        and(
          eq(issueDependencies.companyId, completedIssue.companyId),
          eq(issueDependencies.blockedIssueId, blockedIssueId),
          isNull(issueDependencies.resolvedAt),
        ),
      );

    if (unresolvedDeps.length > 0) continue;

    const ceoAgent = await findRootCeoAgent(db, completedIssue.companyId);
    if (!ceoAgent) {
      logger.warn(
        { issueId: blockedIssueId, companyId: completedIssue.companyId },
        "dependency-resolution-hook: no CEO agent found, skipping auto-unblock reassignment",
      );
      continue;
    }

    const updated = await db
      .update(issues)
      .set({
        status: "todo",
        assigneeAgentId: ceoAgent.id,
        assigneeUserId: null,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, blockedIssueId))
      .returning({
        id: issues.id,
        identifier: issues.identifier,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) continue;

    const completedLink = issueLink(completedIssue.identifier, completedIssue.id);
    const blockedLink = issueLink(updated.identifier, updated.id);
    const [comment] = await db
      .insert(issueComments)
      .values({
        issueId: blockedIssueId,
        companyId: completedIssue.companyId,
        body:
          `Auto-unblocked because dependency ${completedLink} was completed.\n\n` +
          `Routing ${blockedLink} back to CEO for next-step coordination.`,
        authorAgentId: null,
        authorUserId: null,
      })
      .returning();

    if (heartbeat && comment) {
      heartbeat
        .wakeup(ceoAgent.id, {
          source: "automation",
          triggerDetail: "system",
          reason: "dependency_resolved",
          payload: { issueId: blockedIssueId, commentId: comment.id },
          requestedByActorType: "system",
          requestedByActorId: "dependency_resolution_hook",
          contextSnapshot: {
            issueId: blockedIssueId,
            taskId: blockedIssueId,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "dependency_resolved",
            source: "dependency_resolution_hook",
          },
        })
        .catch((err) =>
          logger.warn(
            { err, issueId: blockedIssueId, ceoAgentId: ceoAgent.id },
            "dependency-resolution-hook: failed to wake CEO",
          ),
        );
    }

    await logActivity(db, {
      companyId: completedIssue.companyId,
      actorType: "system",
      actorId: "dependency_resolution_hook",
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      details: {
        status: "todo",
        assigneeAgentId: ceoAgent.id,
        source: "dependency_resolution_hook",
        dependencyResolvedByIssueId: completedIssue.id,
        dependencyResolvedByIdentifier: completedIssue.identifier,
      },
    });
  }
}
