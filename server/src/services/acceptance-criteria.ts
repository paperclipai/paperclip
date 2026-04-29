import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueAcceptanceCriteria, issueWorkProducts } from "@paperclipai/db";
import {
  ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE,
  type IssueAcceptanceCriterion,
  type IssueAcceptanceCriterionState,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";

type Row = typeof issueAcceptanceCriteria.$inferSelect;

function toCriterion(row: Row): IssueAcceptanceCriterion {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    text: row.text,
    state: row.state as IssueAcceptanceCriterionState,
    notes: row.notes ?? null,
    position: row.position,
    evidenceWorkProductId: row.evidenceWorkProductId ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    resolvedByAgentId: row.resolvedByAgentId ?? null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedByRunId: row.resolvedByRunId ?? null,
    resolvedAt: row.resolvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type AcceptanceCriterionActor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export type CreateAcceptanceCriterionInput = {
  text: string;
  notes?: string | null;
  position?: number;
  state?: IssueAcceptanceCriterionState;
  evidenceWorkProductId?: string | null;
  actor?: AcceptanceCriterionActor;
};

export type UpdateAcceptanceCriterionInput = {
  text?: string;
  notes?: string | null;
  position?: number;
  state?: IssueAcceptanceCriterionState;
  evidenceWorkProductId?: string | null;
  actor?: AcceptanceCriterionActor;
};

export type SetAcceptanceCriterionStateInput = {
  state: IssueAcceptanceCriterionState;
  evidenceWorkProductId?: string | null;
  notes?: string | null;
  actor?: AcceptanceCriterionActor;
};

function isResolvingState(state: IssueAcceptanceCriterionState | undefined): boolean {
  return state === "met" || state === "failed";
}

async function assertEvidenceBelongsToIssue(
  dbOrTx: Pick<Db, "select">,
  workProductId: string,
  companyId: string,
  issueId: string,
) {
  const evidence = await dbOrTx
    .select({
      id: issueWorkProducts.id,
      companyId: issueWorkProducts.companyId,
      issueId: issueWorkProducts.issueId,
    })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.id, workProductId))
    .then((rows) => rows[0] ?? null);

  if (!evidence) {
    throw notFound("Evidence work product not found");
  }
  if (evidence.companyId !== companyId || evidence.issueId !== issueId) {
    throw conflict("Evidence work product does not belong to this issue");
  }
}

export function acceptanceCriteriaService(db: Db) {
  return {
    listForIssue: async (issueId: string): Promise<IssueAcceptanceCriterion[]> => {
      const rows = await db
        .select()
        .from(issueAcceptanceCriteria)
        .where(eq(issueAcceptanceCriteria.issueId, issueId))
        .orderBy(asc(issueAcceptanceCriteria.position), asc(issueAcceptanceCriteria.createdAt));
      return rows.map(toCriterion);
    },

    getById: async (id: string): Promise<IssueAcceptanceCriterion | null> => {
      const row = await db
        .select()
        .from(issueAcceptanceCriteria)
        .where(eq(issueAcceptanceCriteria.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toCriterion(row) : null;
    },

    countForIssue: async (issueId: string): Promise<number> => {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueAcceptanceCriteria)
        .where(eq(issueAcceptanceCriteria.issueId, issueId));
      return result[0]?.count ?? 0;
    },

    createForIssue: async (
      issueId: string,
      companyId: string,
      input: CreateAcceptanceCriterionInput,
    ): Promise<IssueAcceptanceCriterion> => {
      return await db.transaction(async (tx) => {
        const existing = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(issueAcceptanceCriteria)
          .where(eq(issueAcceptanceCriteria.issueId, issueId));
        if ((existing[0]?.count ?? 0) >= ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE) {
          throw conflict(
            `Issue already has the maximum of ${ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE} acceptance criteria`,
          );
        }

        let position = input.position;
        if (position === undefined) {
          const last = await tx
            .select({ maxPosition: sql<number | null>`max(${issueAcceptanceCriteria.position})` })
            .from(issueAcceptanceCriteria)
            .where(eq(issueAcceptanceCriteria.issueId, issueId));
          const maxPosition = last[0]?.maxPosition;
          position = typeof maxPosition === "number" ? maxPosition + 1 : 0;
        }

        if (input.evidenceWorkProductId) {
          await assertEvidenceBelongsToIssue(tx, input.evidenceWorkProductId, companyId, issueId);
        }

        const state = input.state ?? "pending";
        const isResolved = isResolvingState(state);
        const actor = input.actor ?? {};
        const now = new Date();

        const inserted = await tx
          .insert(issueAcceptanceCriteria)
          .values({
            companyId,
            issueId,
            text: input.text.trim(),
            notes: input.notes?.trim() || null,
            position,
            state,
            evidenceWorkProductId: input.evidenceWorkProductId ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            createdByRunId: actor.runId ?? null,
            resolvedByAgentId: isResolved ? actor.agentId ?? null : null,
            resolvedByUserId: isResolved ? actor.userId ?? null : null,
            resolvedByRunId: isResolved ? actor.runId ?? null : null,
            resolvedAt: isResolved ? now : null,
          })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error("Failed to create acceptance criterion");
        return toCriterion(row);
      });
    },

    update: async (
      id: string,
      patch: UpdateAcceptanceCriterionInput,
    ): Promise<IssueAcceptanceCriterion> => {
      return await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueAcceptanceCriteria)
          .where(eq(issueAcceptanceCriteria.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Acceptance criterion not found");

        const update: Partial<typeof issueAcceptanceCriteria.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.text !== undefined) update.text = patch.text.trim();
        if (patch.notes !== undefined) update.notes = patch.notes?.trim() || null;
        if (patch.position !== undefined) update.position = patch.position;

        if (patch.evidenceWorkProductId !== undefined) {
          if (patch.evidenceWorkProductId) {
            await assertEvidenceBelongsToIssue(
              tx,
              patch.evidenceWorkProductId,
              existing.companyId,
              existing.issueId,
            );
          }
          update.evidenceWorkProductId = patch.evidenceWorkProductId ?? null;
        }

        if (patch.state !== undefined && patch.state !== existing.state) {
          const actor = patch.actor ?? {};
          update.state = patch.state;
          if (isResolvingState(patch.state)) {
            update.resolvedAt = new Date();
            update.resolvedByAgentId = actor.agentId ?? null;
            update.resolvedByUserId = actor.userId ?? null;
            update.resolvedByRunId = actor.runId ?? null;
          } else {
            update.resolvedAt = null;
            update.resolvedByAgentId = null;
            update.resolvedByUserId = null;
            update.resolvedByRunId = null;
          }
        }

        const updated = await tx
          .update(issueAcceptanceCriteria)
          .set(update)
          .where(eq(issueAcceptanceCriteria.id, id))
          .returning();
        const row = updated[0];
        if (!row) throw notFound("Acceptance criterion not found");
        return toCriterion(row);
      });
    },

    setState: async (
      id: string,
      input: SetAcceptanceCriterionStateInput,
    ): Promise<IssueAcceptanceCriterion> => {
      return await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueAcceptanceCriteria)
          .where(eq(issueAcceptanceCriteria.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Acceptance criterion not found");

        const actor = input.actor ?? {};
        const update: Partial<typeof issueAcceptanceCriteria.$inferInsert> = {
          state: input.state,
          updatedAt: new Date(),
        };

        if (input.notes !== undefined) update.notes = input.notes?.trim() || null;

        if (input.evidenceWorkProductId !== undefined) {
          if (input.evidenceWorkProductId) {
            await assertEvidenceBelongsToIssue(
              tx,
              input.evidenceWorkProductId,
              existing.companyId,
              existing.issueId,
            );
          }
          update.evidenceWorkProductId = input.evidenceWorkProductId ?? null;
        }

        if (isResolvingState(input.state)) {
          update.resolvedAt = new Date();
          update.resolvedByAgentId = actor.agentId ?? null;
          update.resolvedByUserId = actor.userId ?? null;
          update.resolvedByRunId = actor.runId ?? null;
        } else {
          update.resolvedAt = null;
          update.resolvedByAgentId = null;
          update.resolvedByUserId = null;
          update.resolvedByRunId = null;
        }

        const updated = await tx
          .update(issueAcceptanceCriteria)
          .set(update)
          .where(eq(issueAcceptanceCriteria.id, id))
          .returning();
        const row = updated[0];
        if (!row) throw notFound("Acceptance criterion not found");
        return toCriterion(row);
      });
    },

    remove: async (id: string): Promise<IssueAcceptanceCriterion | null> => {
      const removed = await db
        .delete(issueAcceptanceCriteria)
        .where(eq(issueAcceptanceCriteria.id, id))
        .returning();
      return removed[0] ? toCriterion(removed[0]) : null;
    },

    bulkCreateForIssue: async (
      issueId: string,
      companyId: string,
      texts: string[],
      actor?: AcceptanceCriterionActor,
    ): Promise<IssueAcceptanceCriterion[]> => {
      const trimmed = texts.map((text) => text.trim()).filter((text) => text.length > 0);
      if (trimmed.length === 0) return [];
      if (trimmed.length > ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE) {
        throw badRequest(
          `Cannot create more than ${ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE} acceptance criteria at once`,
        );
      }

      return await db.transaction(async (tx) => {
        const existing = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(issueAcceptanceCriteria)
          .where(eq(issueAcceptanceCriteria.issueId, issueId));
        const existingCount = existing[0]?.count ?? 0;
        if (existingCount + trimmed.length > ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE) {
          throw conflict(
            `Adding ${trimmed.length} acceptance criteria would exceed the per-issue limit of ${ISSUE_ACCEPTANCE_CRITERIA_MAX_PER_ISSUE}`,
          );
        }

        const last = await tx
          .select({ maxPosition: sql<number | null>`max(${issueAcceptanceCriteria.position})` })
          .from(issueAcceptanceCriteria)
          .where(eq(issueAcceptanceCriteria.issueId, issueId));
        const startPosition = (last[0]?.maxPosition ?? -1) + 1;

        const rows = await tx
          .insert(issueAcceptanceCriteria)
          .values(
            trimmed.map((text, index) => ({
              companyId,
              issueId,
              text,
              state: "pending" as const,
              position: startPosition + index,
              createdByAgentId: actor?.agentId ?? null,
              createdByUserId: actor?.userId ?? null,
              createdByRunId: actor?.runId ?? null,
            })),
          )
          .returning();
        return rows.map(toCriterion);
      });
    },

    deleteAllForIssue: async (issueId: string): Promise<number> => {
      const removed = await db
        .delete(issueAcceptanceCriteria)
        .where(eq(issueAcceptanceCriteria.issueId, issueId))
        .returning({ id: issueAcceptanceCriteria.id });
      return removed.length;
    },
  };
}
