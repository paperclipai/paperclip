import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvalDecisions, approvals } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { notifyHireApproved } from "./hire-hook.js";

function redactApprovalComment<T extends { body: string }>(comment: T): T {
  return {
    ...comment,
    body: redactCurrentUserText(comment.body),
  };
}

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  /** Record a vote in approval_decisions. Throws on duplicate. */
  async function recordVote(
    approval: ApprovalRecord,
    userId: string,
    decision: "approved" | "rejected",
    note: string | null | undefined,
  ) {
    try {
      return await db
        .insert(approvalDecisions)
        .values({
          approvalId: approval.id,
          companyId: approval.companyId,
          userId,
          decision,
          note: note ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    } catch (err: unknown) {
      // PostgreSQL unique_violation (23505) on approval_decisions_approval_user_uq
      if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505") {
        throw unprocessable("You have already voted on this approval");
      }
      throw err;
    }
  }

  /** Count "approved" votes for an approval. */
  async function countApprovedVotes(approvalId: string): Promise<number> {
    return db
      .select({ count: count() })
      .from(approvalDecisions)
      .where(
        and(
          eq(approvalDecisions.approvalId, approvalId),
          eq(approvalDecisions.decision, "approved"),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);

      // Gate: only resolvable statuses can accept votes
      if (!canResolveStatuses.has(existing.status)) {
        if (existing.status === "approved") {
          return { approval: existing, applied: false, votesReceived: existing.requiredApprovalCount, votesRequired: existing.requiredApprovalCount };
        }
        throw unprocessable("Only pending or revision requested approvals can be approved");
      }

      // Record vote (throws on duplicate)
      await recordVote(existing, decidedByUserId, "approved", decisionNote);
      const approvedCount = await countApprovedVotes(id);
      const required = existing.requiredApprovalCount;

      // If quorum not yet met, return without resolving
      if (approvedCount < required) {
        return { approval: existing, applied: false, votesReceived: approvedCount, votesRequired: required };
      }

      // Quorum met — resolve the approval
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      return { approval: updated, applied, votesReceived: approvedCount, votesRequired: required };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);

      // Gate: only resolvable statuses
      if (!canResolveStatuses.has(existing.status)) {
        if (existing.status === "rejected") {
          return { approval: existing, applied: false };
        }
        throw unprocessable("Only pending or revision requested approvals can be rejected");
      }

      // Record a rejection vote
      await recordVote(existing, decidedByUserId, "rejected", decisionNote);

      // Single veto — immediately reject
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      // Clear all previous votes on resubmit
      await db
        .delete(approvalDecisions)
        .where(eq(approvalDecisions.approvalId, id));

      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    listDecisions: async (approvalId: string) => {
      await getExistingApproval(approvalId);
      return db
        .select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.approvalId, approvalId))
        .orderBy(asc(approvalDecisions.createdAt));
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map(redactApprovalComment));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const redactedBody = redactCurrentUserText(body);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0]));
    },
  };
}
