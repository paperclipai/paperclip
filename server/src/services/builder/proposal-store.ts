import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { builderProposals } from "@paperclipai/db";
import type {
  BuilderProposal,
  BuilderProposalStatus,
} from "@paperclipai/shared";

/**
 * Persistence helper for Builder mutation proposals.
 *
 * Mutation tools never mutate directly in v1; they create a proposal whose
 * `kind` and `payload` describe the deferred action. A board operator then
 * applies or rejects it. The `apply` path re-invokes a registered applier
 * (see `applier-registry.ts`) which calls the existing core service so all
 * invariants stay in place.
 */

type Row = typeof builderProposals.$inferSelect;

function toProposal(row: Row): BuilderProposal {
  return {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    companyId: row.companyId,
    kind: row.kind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as BuilderProposalStatus,
    appliedActivityId: row.appliedActivityId,
    approvalId: row.approvalId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function builderProposalStore(db: Db) {
  return {
    list: async (
      companyId: string,
      filter?: { sessionId?: string; status?: BuilderProposalStatus },
    ): Promise<BuilderProposal[]> => {
      const conditions = [eq(builderProposals.companyId, companyId)];
      if (filter?.sessionId) {
        conditions.push(eq(builderProposals.sessionId, filter.sessionId));
      }
      if (filter?.status) {
        conditions.push(eq(builderProposals.status, filter.status));
      }
      const rows = await db
        .select()
        .from(builderProposals)
        .where(and(...conditions))
        .orderBy(desc(builderProposals.createdAt));
      return rows.map(toProposal);
    },

    getById: async (
      companyId: string,
      proposalId: string,
    ): Promise<BuilderProposal | null> => {
      const row = await db
        .select()
        .from(builderProposals)
        .where(
          and(
            eq(builderProposals.id, proposalId),
            eq(builderProposals.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row ? toProposal(row) : null;
    },

    create: async (input: {
      sessionId: string;
      messageId: string;
      companyId: string;
      kind: string;
      payload: Record<string, unknown>;
      approvalId?: string | null;
    }): Promise<BuilderProposal> => {
      const [row] = await db
        .insert(builderProposals)
        .values({
          sessionId: input.sessionId,
          messageId: input.messageId,
          companyId: input.companyId,
          kind: input.kind,
          payload: input.payload,
          approvalId: input.approvalId ?? null,
          status: "pending",
        })
        .returning();
      return toProposal(row);
    },

    markApplied: async (
      proposalId: string,
      decidedByUserId: string,
      appliedActivityId: string | null,
    ): Promise<BuilderProposal | null> => {
      const [row] = await db
        .update(builderProposals)
        .set({
          status: "applied",
          appliedActivityId,
          decidedByUserId,
          decidedAt: new Date(),
          updatedAt: new Date(),
          failureReason: null,
        })
        .where(eq(builderProposals.id, proposalId))
        .returning();
      return row ? toProposal(row) : null;
    },

    markRejected: async (
      proposalId: string,
      decidedByUserId: string,
    ): Promise<BuilderProposal | null> => {
      const [row] = await db
        .update(builderProposals)
        .set({
          status: "rejected",
          decidedByUserId,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(builderProposals.id, proposalId))
        .returning();
      return row ? toProposal(row) : null;
    },

    markFailed: async (
      proposalId: string,
      decidedByUserId: string,
      failureReason: string,
    ): Promise<BuilderProposal | null> => {
      const [row] = await db
        .update(builderProposals)
        .set({
          status: "failed",
          decidedByUserId,
          decidedAt: new Date(),
          failureReason,
          updatedAt: new Date(),
        })
        .where(eq(builderProposals.id, proposalId))
        .returning();
      return row ? toProposal(row) : null;
    },

    updateStatusFromApproval: async (
      proposalId: string,
      status: BuilderProposalStatus,
    ): Promise<BuilderProposal | null> => {
      const [row] = await db
        .update(builderProposals)
        .set({
          status,
          updatedAt: new Date(),
        })
        .where(eq(builderProposals.id, proposalId))
        .returning();
      return row ? toProposal(row) : null;
    },

    /** Pending count, useful for the Builder UI badge. */
    pendingCount: async (companyId: string): Promise<number> => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(builderProposals)
        .where(
          and(
            eq(builderProposals.companyId, companyId),
            eq(builderProposals.status, "pending"),
          ),
        );
      return Number(row?.n ?? 0);
    },
  };
}

export type BuilderProposalStore = ReturnType<typeof builderProposalStore>;
