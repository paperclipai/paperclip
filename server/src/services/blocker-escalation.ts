import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyMemberships,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";

/**
 * When an agent marks an issue as "blocked", automatically create a linked
 * human-action issue assigned to the company owner describing what's needed.
 * When the human resolves that blocker issue, set the original back to "todo"
 * and wake the assigned agent.
 */
export function blockerEscalationService(db: Db) {
  const svc = issueService(db);

  async function findCompanyOwnerUserId(companyId: string): Promise<string | null> {
    const owner = await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return owner?.principalId ?? null;
  }

  async function findLatestAgentComment(
    issueId: string,
    agentId: string,
  ): Promise<string | null> {
    const comment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorAgentId, agentId),
        ),
      )
      .orderBy(issueComments.createdAt)
      .then((rows) => rows.at(-1) ?? null);
    return comment?.body ?? null;
  }

  async function hasOpenBlockerIssue(issueId: string): Promise<boolean> {
    const existing = await db
      .select({ id: issueRelations.id, relatedStatus: issues.status })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .where(
        and(
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) =>
        rows.filter(
          (r) => r.relatedStatus !== "done" && r.relatedStatus !== "cancelled",
        ),
      );
    return existing.length > 0;
  }

  return {
    /**
     * Create a human-action blocker issue linked to the blocked issue.
     */
    async createBlockerIssue(opts: {
      blockedIssue: {
        id: string;
        companyId: string;
        identifier: string | null;
        title: string;
        priority: string;
        projectId: string | null;
        assigneeAgentId: string | null;
      };
      commentBody?: string;
      actorAgentId?: string;
    }): Promise<{ blockerIssueId: string } | null> {
      const { blockedIssue, commentBody, actorAgentId } = opts;

      // Don't create duplicate blocker issues
      if (await hasOpenBlockerIssue(blockedIssue.id)) {
        logger.info(
          { issueId: blockedIssue.id },
          "skipping blocker escalation: open blocker issue already exists",
        );
        return null;
      }

      const ownerUserId = await findCompanyOwnerUserId(blockedIssue.companyId);
      if (!ownerUserId) {
        logger.warn(
          { companyId: blockedIssue.companyId, issueId: blockedIssue.id },
          "skipping blocker escalation: no active company owner found",
        );
        return null;
      }

      // Try to extract the reason from the comment or the agent's latest comment
      let reason = commentBody ?? null;
      if (!reason && actorAgentId) {
        reason = await findLatestAgentComment(blockedIssue.id, actorAgentId);
      }

      const issueRef = blockedIssue.identifier ?? blockedIssue.id.slice(0, 8);
      const title = `[Action needed] ${issueRef}: ${blockedIssue.title}`;
      const description = [
        `This issue was automatically created because **${issueRef}** was marked as blocked.`,
        "",
        reason ? `**Reason from agent:**` : "",
        reason ? `> ${reason.split("\n").join("\n> ")}` : "",
        "",
        `Please review and take the necessary action. When you resolve this issue, **${issueRef}** will be automatically unblocked.`,
      ]
        .filter((line) => line !== "")
        .join("\n");

      const blockerIssue = await svc.create(blockedIssue.companyId, {
        title,
        description,
        status: "todo",
        priority: blockedIssue.priority as "critical" | "high" | "medium" | "low",
        projectId: blockedIssue.projectId,
        assigneeUserId: ownerUserId,
        originKind: "blocker_escalation",
        originId: blockedIssue.id,
      });

      // Create the "blocks" relation: blockerIssue blocks blockedIssue
      await db.insert(issueRelations).values({
        companyId: blockedIssue.companyId,
        issueId: blockerIssue.id,
        relatedIssueId: blockedIssue.id,
        type: "blocks",
      });

      // System comment on the original blocked issue
      const blockerRef = blockerIssue.identifier ?? blockerIssue.id.slice(0, 8);
      await svc.addComment(blockedIssue.id, `A human-action issue **${blockerRef}** has been created and assigned to the company owner.`, {});

      // System comment on the blocker issue
      await svc.addComment(blockerIssue.id, `This issue was auto-created because **${issueRef}** was marked as blocked. Resolving this issue will unblock it.`, {});

      logger.info(
        {
          blockedIssueId: blockedIssue.id,
          blockerIssueId: blockerIssue.id,
          ownerUserId,
        },
        "created blocker escalation issue",
      );

      return { blockerIssueId: blockerIssue.id };
    },

    /**
     * When a blocker issue is resolved, unblock any issues it was blocking.
     * Optionally post a comment from the human with context for the agent.
     */
    async handleBlockerResolved(
      resolvedIssue: {
        id: string;
        companyId: string;
        identifier: string | null;
      },
      heartbeat: {
        wakeup: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
      },
      resolverComment?: string,
    ): Promise<{ unblockedCount: number }> {
      // Find issues that this resolved issue was blocking
      const blockingRelations = await db
        .select({
          relatedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.issueId, resolvedIssue.id),
            eq(issueRelations.type, "blocks"),
          ),
        );

      if (blockingRelations.length === 0) return { unblockedCount: 0 };

      const blockedIssueIds = blockingRelations.map((r) => r.relatedIssueId);

      // Load the blocked issues that are still in "blocked" status
      const blockedIssues = await db
        .select()
        .from(issues)
        .where(
          and(
            inArray(issues.id, blockedIssueIds),
            eq(issues.status, "blocked"),
          ),
        );

      const resolvedRef = resolvedIssue.identifier ?? resolvedIssue.id.slice(0, 8);
      let unblockedCount = 0;

      for (const blockedIssue of blockedIssues) {
        // Post the human's comment on the original issue first, so the agent sees it
        if (resolverComment) {
          await svc.addComment(blockedIssue.id, resolverComment, {});
        }

        // Add a system comment about the unblock
        await svc.addComment(
          blockedIssue.id,
          `Unblocked: **${resolvedRef}** has been resolved.`,
          {},
        );

        // Transition back to todo
        await svc.update(blockedIssue.id, { status: "todo" });

        // Wake the assigned agent
        if (blockedIssue.assigneeAgentId) {
          void queueIssueAssignmentWakeup({
            heartbeat,
            issue: {
              id: blockedIssue.id,
              assigneeAgentId: blockedIssue.assigneeAgentId,
              status: "todo",
            },
            reason: "issue_unblocked",
            mutation: "update",
            contextSource: "blocker.resolved",
            requestedByActorType: "system",
          });
        }

        unblockedCount++;
      }

      logger.info(
        {
          resolvedIssueId: resolvedIssue.id,
          unblockedCount,
          unblockedIssueIds: blockedIssues.map((i) => i.id),
        },
        "handled blocker resolution",
      );

      return { unblockedCount };
    },

    /**
     * List relations for a given issue (both directions).
     */
    async listRelations(issueId: string) {
      const rows = await db
        .select({
          id: issueRelations.id,
          companyId: issueRelations.companyId,
          issueId: issueRelations.issueId,
          relatedIssueId: issueRelations.relatedIssueId,
          type: issueRelations.type,
          createdAt: issueRelations.createdAt,
        })
        .from(issueRelations)
        .where(
          eq(issueRelations.issueId, issueId),
        );

      // Also find reverse relations (issues that reference this issue)
      const reverseRows = await db
        .select({
          id: issueRelations.id,
          companyId: issueRelations.companyId,
          issueId: issueRelations.issueId,
          relatedIssueId: issueRelations.relatedIssueId,
          type: issueRelations.type,
          createdAt: issueRelations.createdAt,
        })
        .from(issueRelations)
        .where(
          eq(issueRelations.relatedIssueId, issueId),
        );

      // Collect all related issue IDs to enrich with basic info
      const allRelatedIds = new Set([
        ...rows.map((r) => r.relatedIssueId),
        ...reverseRows.map((r) => r.issueId),
      ]);

      const relatedIssues =
        allRelatedIds.size > 0
          ? await db
              .select({
                id: issues.id,
                identifier: issues.identifier,
                title: issues.title,
                status: issues.status,
                assigneeAgentId: issues.assigneeAgentId,
                assigneeUserId: issues.assigneeUserId,
              })
              .from(issues)
              .where(inArray(issues.id, Array.from(allRelatedIds)))
          : [];

      const issueMap = new Map(relatedIssues.map((i) => [i.id, i]));

      return [
        ...rows.map((r) => ({
          ...r,
          relatedIssue: issueMap.get(r.relatedIssueId) ?? null,
        })),
        ...reverseRows.map((r) => ({
          ...r,
          relatedIssue: issueMap.get(r.issueId) ?? null,
        })),
      ];
    },

    /**
     * Create a relation between two issues.
     */
    async createRelation(
      companyId: string,
      issueId: string,
      relatedIssueId: string,
      type: string,
    ) {
      const [relation] = await db
        .insert(issueRelations)
        .values({ companyId, issueId, relatedIssueId, type })
        .returning();
      return relation;
    },

    /**
     * Delete a relation by ID.
     */
    async deleteRelation(id: string) {
      const [deleted] = await db
        .delete(issueRelations)
        .where(eq(issueRelations.id, id))
        .returning();
      return deleted ?? null;
    },
  };
}
