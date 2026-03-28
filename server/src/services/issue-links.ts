import { eq, and, sql, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueLinks, issues } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueLinkService(db: Db) {
  async function getIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Detect cycles: if adding source→target would create a cycle.
   * Walk forward from target — if we ever reach source, it's a cycle.
   */
  async function wouldCreateCycle(
    sourceId: string,
    targetId: string,
    linkType: string,
  ): Promise<boolean> {
    const result = await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT ${issueLinks.targetId} AS reachable
        FROM ${issueLinks}
        WHERE ${issueLinks.sourceId} = ${targetId}
          AND ${issueLinks.linkType} = ${linkType}
        UNION
        SELECT il.target_id AS reachable
        FROM ${issueLinks} il
        JOIN chain c ON il.source_id = c.reachable
        WHERE il.link_type = ${linkType}
      )
      SELECT 1 AS found FROM chain WHERE reachable = ${sourceId} LIMIT 1
    `);
    return (result as unknown as unknown[]).length > 0;
  }

  return {
    /**
     * List all links (both directions) for an issue, with enriched details.
     */
    listForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      // Outgoing: this issue is the source
      const outgoing = await db
        .select({
          id: issueLinks.id,
          linkType: issueLinks.linkType,
          sourceId: issueLinks.sourceId,
          targetId: issueLinks.targetId,
          createdAt: issueLinks.createdAt,
          targetIdentifier: issues.identifier,
          targetTitle: issues.title,
          targetStatus: issues.status,
        })
        .from(issueLinks)
        .innerJoin(issues, eq(issueLinks.targetId, issues.id))
        .where(eq(issueLinks.sourceId, issueId));

      // Incoming: this issue is the target
      const incoming = await db
        .select({
          id: issueLinks.id,
          linkType: issueLinks.linkType,
          sourceId: issueLinks.sourceId,
          targetId: issueLinks.targetId,
          createdAt: issueLinks.createdAt,
          sourceIdentifier: issues.identifier,
          sourceTitle: issues.title,
          sourceStatus: issues.status,
        })
        .from(issueLinks)
        .innerJoin(issues, eq(issueLinks.sourceId, issues.id))
        .where(eq(issueLinks.targetId, issueId));

      return {
        outgoing: outgoing.map((r) => ({
          id: r.id,
          linkType: r.linkType,
          sourceId: r.sourceId,
          sourceIdentifier: issue.identifier,
          sourceTitle: issue.title,
          sourceStatus: issue.status,
          targetId: r.targetId,
          targetIdentifier: r.targetIdentifier,
          targetTitle: r.targetTitle,
          targetStatus: r.targetStatus,
          createdAt: r.createdAt,
        })),
        incoming: incoming.map((r) => ({
          id: r.id,
          linkType: r.linkType,
          sourceId: r.sourceId,
          sourceIdentifier: r.sourceIdentifier,
          sourceTitle: r.sourceTitle,
          sourceStatus: r.sourceStatus,
          targetId: r.targetId,
          targetIdentifier: issue.identifier,
          targetTitle: issue.title,
          targetStatus: issue.status,
          createdAt: r.createdAt,
        })),
      };
    },

    /**
     * Create a link from sourceId → targetId.
     * Rejects if it would form a cycle.
     */
    create: async (
      sourceId: string,
      data: { targetId: string; linkType: string },
      actor?: LinkActor,
    ) => {
      const source = await getIssue(sourceId);
      if (!source) throw notFound("Source issue not found");

      const target = await getIssue(data.targetId);
      if (!target) throw notFound("Target issue not found");

      if (source.companyId !== target.companyId) {
        throw unprocessable("Source and target issues must belong to the same company");
      }

      if (sourceId === data.targetId) {
        throw unprocessable("An issue cannot link to itself");
      }

      // Cycle detection
      const cycle = await wouldCreateCycle(sourceId, data.targetId, data.linkType);
      if (cycle) {
        throw unprocessable(
          "This link would create a circular dependency chain",
        );
      }

      await db
        .insert(issueLinks)
        .values({
          companyId: source.companyId,
          sourceId,
          targetId: data.targetId,
          linkType: data.linkType,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        })
        .onConflictDoNothing();

      return db
        .select()
        .from(issueLinks)
        .where(
          and(
            eq(issueLinks.sourceId, sourceId),
            eq(issueLinks.targetId, data.targetId),
            eq(issueLinks.linkType, data.linkType),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Delete a link by its ID.
     */
    remove: async (linkId: string) => {
      const link = await db
        .select()
        .from(issueLinks)
        .where(eq(issueLinks.id, linkId))
        .then((rows) => rows[0] ?? null);

      if (!link) throw notFound("Issue link not found");

      await db.delete(issueLinks).where(eq(issueLinks.id, linkId));

      return link;
    },

    /**
     * Get a link by ID.
     */
    getById: async (linkId: string) => {
      return db
        .select()
        .from(issueLinks)
        .where(eq(issueLinks.id, linkId))
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Find all trigger links where sourceId is the given issue.
     * Used by the dependency trigger mechanism.
     */
    findTriggersFromSource: async (sourceId: string) => {
      return db
        .select()
        .from(issueLinks)
        .where(
          and(
            eq(issueLinks.sourceId, sourceId),
            eq(issueLinks.linkType, "triggers"),
          ),
        );
    },

    /**
     * Check if all upstream "triggers" dependencies for a target are done.
     * Returns true if all upstream sources have status "done".
     */
    allUpstreamTriggersDone: async (targetId: string): Promise<boolean> => {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueLinks)
        .innerJoin(issues, eq(issueLinks.sourceId, issues.id))
        .where(
          and(
            eq(issueLinks.targetId, targetId),
            eq(issueLinks.linkType, "triggers"),
            sql`${issues.status} != 'done'`,
          ),
        );
      return (result[0]?.count ?? 0) === 0;
    },
  };
}
