import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueDependencies, issues } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];

export function issueDependencyService(db: Db) {
  return {
    /**
     * Add a blocker dependency: `issueId` is blocked by `blockerIssueId`.
     * Validates company scoping, rejects self-edges and duplicates.
     */
    addDependency: async (
      issueId: string,
      blockerIssueId: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      if (issueId === blockerIssueId) {
        throw unprocessable("An issue cannot depend on itself");
      }

      const [issue, blocker] = await Promise.all([
        db.select().from(issues).where(eq(issues.id, issueId)).then((r) => r[0] ?? null),
        db.select().from(issues).where(eq(issues.id, blockerIssueId)).then((r) => r[0] ?? null),
      ]);

      if (!issue) throw notFound("Issue not found");
      if (!blocker) throw notFound("Blocker issue not found");
      if (issue.companyId !== blocker.companyId) {
        throw unprocessable("Dependencies must be within the same company");
      }

      try {
        const [row] = await db
          .insert(issueDependencies)
          .values({
            companyId: issue.companyId,
            issueId,
            blockerIssueId,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
          })
          .returning();
        return row;
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("issue_dependencies_unique_edge")) {
          throw conflict("This dependency already exists");
        }
        throw err;
      }
    },

    /**
     * Remove a specific dependency edge.
     */
    removeDependency: async (issueId: string, blockerIssueId: string) => {
      const deleted = await db
        .delete(issueDependencies)
        .where(
          and(
            eq(issueDependencies.issueId, issueId),
            eq(issueDependencies.blockerIssueId, blockerIssueId),
          ),
        )
        .returning()
        .then((r) => r[0] ?? null);
      return deleted;
    },

    /**
     * List all blocker dependencies for an issue (what blocks this issue),
     * enriched with blocker issue metadata.
     */
    listBlockers: async (issueId: string) => {
      const rows = await db
        .select({
          id: issueDependencies.id,
          issueId: issueDependencies.issueId,
          blockerIssueId: issueDependencies.blockerIssueId,
          blockerIdentifier: issues.identifier,
          blockerTitle: issues.title,
          blockerStatus: issues.status,
          createdAt: issueDependencies.createdAt,
        })
        .from(issueDependencies)
        .innerJoin(issues, eq(issues.id, issueDependencies.blockerIssueId))
        .where(eq(issueDependencies.issueId, issueId));
      return rows;
    },

    /**
     * List all issues that depend on (are blocked by) this issue,
     * enriched with dependent issue metadata.
     */
    listDependents: async (blockerIssueId: string) => {
      const rows = await db
        .select({
          id: issueDependencies.id,
          issueId: issueDependencies.issueId,
          blockerIssueId: issueDependencies.blockerIssueId,
          dependentIdentifier: issues.identifier,
          dependentTitle: issues.title,
          dependentStatus: issues.status,
          dependentAssigneeAgentId: issues.assigneeAgentId,
          createdAt: issueDependencies.createdAt,
        })
        .from(issueDependencies)
        .innerJoin(issues, eq(issues.id, issueDependencies.issueId))
        .where(eq(issueDependencies.blockerIssueId, blockerIssueId));
      return rows;
    },

    /**
     * Find dependent issues whose ALL blockers are now resolved (done/cancelled).
     * Used when a blocker transitions to a terminal status.
     * Only returns non-terminal dependents that have an agent assignee.
     */
    findDependentsReadyToWake: async (blockerIssueId: string) => {
      // Get all dependent issue IDs for this blocker
      const dependentEdges = await db
        .select({ issueId: issueDependencies.issueId })
        .from(issueDependencies)
        .where(eq(issueDependencies.blockerIssueId, blockerIssueId));

      if (dependentEdges.length === 0) return [];

      const dependentIds = dependentEdges.map((e) => e.issueId);

      // For each dependent, check if it has any remaining unresolved blockers.
      // A blocker is unresolved if its status is NOT in terminal statuses.
      // We use a subquery: count unresolved blockers per dependent issue.
      const unresolvedCounts = await db
        .select({
          issueId: issueDependencies.issueId,
          unresolvedCount: sql<number>`count(*) filter (where ${issues.status} not in ('done', 'cancelled'))`.as("unresolved_count"),
        })
        .from(issueDependencies)
        .innerJoin(issues, eq(issues.id, issueDependencies.blockerIssueId))
        .where(inArray(issueDependencies.issueId, dependentIds))
        .groupBy(issueDependencies.issueId);

      // Issues with 0 unresolved blockers are ready to wake
      const readyIds = unresolvedCounts
        .filter((r) => Number(r.unresolvedCount) === 0)
        .map((r) => r.issueId);

      if (readyIds.length === 0) return [];

      // Fetch the actual issue records for those ready to wake
      const readyIssues = await db
        .select()
        .from(issues)
        .where(
          and(
            inArray(issues.id, readyIds),
            // Only non-terminal issues with an agent assignee
            sql`${issues.status} not in ('done', 'cancelled')`,
            isNull(issues.hiddenAt),
          ),
        );

      return readyIssues.filter((i) => i.assigneeAgentId != null);
    },

    /**
     * Auto-unblock dependent issues that are currently in `blocked` status.
     * Transitions them to `todo` so they re-enter the assignment queue.
     */
    autoUnblockDependents: async (issueIds: string[]) => {
      if (issueIds.length === 0) return [];
      const now = new Date();
      return db
        .update(issues)
        .set({ status: "todo", updatedAt: now })
        .where(
          and(
            inArray(issues.id, issueIds),
            eq(issues.status, "blocked"),
          ),
        )
        .returning({ id: issues.id, identifier: issues.identifier });
    },
  };
}
