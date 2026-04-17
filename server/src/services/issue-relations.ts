import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
import type { IssueRelationType } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

interface RelationActor {
  agentId?: string | null;
  userId?: string | null;
}

// `blocks` and `blocked_by` are mutual inverses. `related` and `duplicate`
// are symmetric — their inverse has the same type.
function inverseType(type: IssueRelationType): IssueRelationType {
  switch (type) {
    case "blocks":
      return "blocked_by";
    case "blocked_by":
      return "blocks";
    case "related":
      return "related";
    case "duplicate":
      return "duplicate";
  }
}

export function issueRelationService(db: Db) {
  async function listForIssue(issueId: string) {
    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    return db
      .select({
        id: issueRelations.id,
        companyId: issueRelations.companyId,
        issueId: issueRelations.issueId,
        relatedIssueId: issueRelations.relatedIssueId,
        type: issueRelations.type,
        createdByAgentId: issueRelations.createdByAgentId,
        createdByUserId: issueRelations.createdByUserId,
        createdAt: issueRelations.createdAt,
        updatedAt: issueRelations.updatedAt,
        relatedIssue: {
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
        },
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, issue.companyId),
          eq(issueRelations.issueId, issueId),
        ),
      );
  }

  async function create(
    issueId: string,
    input: { relatedIssueId: string; type: IssueRelationType },
    actor: RelationActor,
  ) {
    if (input.relatedIssueId === issueId) {
      throw unprocessable("An issue cannot have a relation to itself");
    }

    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .union(
          tx
            .select({ id: issues.id, companyId: issues.companyId })
            .from(issues)
            .where(eq(issues.id, input.relatedIssueId)),
        );
      const issue = rows.find((r) => r.id === issueId) ?? null;
      const related = rows.find((r) => r.id === input.relatedIssueId) ?? null;
      if (!issue) throw notFound("Issue not found");
      if (!related) throw notFound("Related issue not found");
      if (issue.companyId !== related.companyId) {
        throw unprocessable("Issues must belong to the same company");
      }

      const now = new Date();
      const baseValues = {
        companyId: issue.companyId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdAt: now,
        updatedAt: now,
      };

      const [created] = await tx
        .insert(issueRelations)
        .values({
          ...baseValues,
          issueId,
          relatedIssueId: input.relatedIssueId,
          type: input.type,
        })
        .onConflictDoNothing({
          target: [
            issueRelations.companyId,
            issueRelations.issueId,
            issueRelations.relatedIssueId,
            issueRelations.type,
          ],
        })
        .returning();

      // Always write the inverse edge (idempotent via onConflictDoNothing).
      await tx
        .insert(issueRelations)
        .values({
          ...baseValues,
          issueId: input.relatedIssueId,
          relatedIssueId: issueId,
          type: inverseType(input.type),
        })
        .onConflictDoNothing({
          target: [
            issueRelations.companyId,
            issueRelations.issueId,
            issueRelations.relatedIssueId,
            issueRelations.type,
          ],
        });

      // If the forward edge already existed, fetch the existing row to return.
      if (!created) {
        const existing = await tx
          .select()
          .from(issueRelations)
          .where(
            and(
              eq(issueRelations.companyId, issue.companyId),
              eq(issueRelations.issueId, issueId),
              eq(issueRelations.relatedIssueId, input.relatedIssueId),
              eq(issueRelations.type, input.type),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return existing;
      }
      return created;
    });
  }

  async function deleteById(issueId: string, relationId: string) {
    return db.transaction(async (tx) => {
      const relation = await tx
        .select()
        .from(issueRelations)
        .where(eq(issueRelations.id, relationId))
        .then((rows) => rows[0] ?? null);
      if (!relation) throw notFound("Relation not found");
      if (relation.issueId !== issueId) {
        throw unprocessable("Relation does not belong to the given issue");
      }

      await tx
        .delete(issueRelations)
        .where(eq(issueRelations.id, relationId));

      // Delete the inverse edge (if present) to keep the graph consistent.
      await tx
        .delete(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, relation.companyId),
            eq(issueRelations.issueId, relation.relatedIssueId),
            eq(issueRelations.relatedIssueId, relation.issueId),
            eq(issueRelations.type, inverseType(relation.type)),
          ),
        );

      return relation;
    });
  }

  /**
   * When a blocking issue reaches a terminal status, auto-transition any
   * dependents currently in `blocked` that have no remaining open blockers
   * from `blocked` → `todo`. Returns the list of transitioned issues for
   * activity logging / wakeup emission by the caller.
   *
   * Complements the existing `listWakeableBlockedDependents` wakeup path in
   * the route: that path fires wakeups for ALL wakeable dependents regardless
   * of status; this method additionally makes the state change deterministic
   * for the `blocked` subset so blocked tasks don't require agent action to
   * re-enter `todo`.
   */
  async function autoTransitionBlockedDependents(
    resolvedIssueId: string,
  ): Promise<Array<{ id: string; companyId: string; assigneeAgentId: string | null }>> {
    return db.transaction(async (tx) => {
      const resolved = await tx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, resolvedIssueId))
        .then((rows) => rows[0] ?? null);
      if (!resolved) return [];

      // Candidates: blocked issues that have a `blocks` relation FROM the
      // resolved issue (i.e. resolved was their blocker).
      const candidates = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, resolved.companyId),
            eq(issueRelations.type, "blocks"),
            eq(issueRelations.issueId, resolvedIssueId),
          ),
        );

      const blocked = candidates.filter((c) => c.status === "blocked");
      if (blocked.length === 0) return [];

      const blockedIds = blocked.map((c) => c.id);

      // Fetch remaining blockers for each candidate.
      const blockerRows = await tx
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerStatus: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, resolved.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, blockedIds),
          ),
        );

      const openBlockersByIssue = new Map<string, number>();
      for (const row of blockerRows) {
        if (row.blockerStatus !== "done" && row.blockerStatus !== "cancelled") {
          openBlockersByIssue.set(row.issueId, (openBlockersByIssue.get(row.issueId) ?? 0) + 1);
        }
      }

      const toTransition = blocked.filter((c) => (openBlockersByIssue.get(c.id) ?? 0) === 0);
      if (toTransition.length === 0) return [];

      await tx
        .update(issues)
        .set({ status: "todo", updatedAt: new Date() })
        .where(inArray(issues.id, toTransition.map((c) => c.id)));

      return toTransition.map((c) => ({
        id: c.id,
        companyId: c.companyId,
        assigneeAgentId: c.assigneeAgentId,
      }));
    });
  }

  return {
    listForIssue,
    create,
    delete: deleteById,
    autoTransitionBlockedDependents,
  };
}

export type IssueRelationService = ReturnType<typeof issueRelationService>;
