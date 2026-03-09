import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { notifyHireApproved } from "./hire-hook.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function approve(id: string, decidedByUserId: string | null, decisionNote?: string | null) {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      throw unprocessable("Only pending or revision requested approvals can be approved");
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: "approved",
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(approvals.id, id))
      .returning()
      .then((rows) => rows[0]);

    let hireApprovedAgentId: string | null = null;
    if (updated.type === "hire_agent") {
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

    return updated;
  }

  async function create(companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) {
    const approval = await db
      .insert(approvals)
      .values({ ...data, companyId })
      .returning()
      .then((rows) => rows[0]);

    // Auto-approve hire_agent for autonomous agents.
    // Requester must belong to the same company to prevent cross-company spoofing.
    if (approval.type === "hire_agent" && data.requestedByAgentId) {
      const requester = await agentsSvc.getById(data.requestedByAgentId);
      if (requester?.companyId === companyId && requester.trustLevel === "autonomous") {
        const approved = await approve(approval.id, null, "Auto-approved: autonomous trust level");
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: data.requestedByAgentId,
          agentId: data.requestedByAgentId,
          action: "approval.approved",
          entityType: "approval",
          entityId: approved.id,
          details: {
            type: approved.type,
            trigger: "trust_auto_approve",
            requestedByAgentId: data.requestedByAgentId,
          },
        });
        return approved;
      }
    }

    return approval;
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

    create,
    approve,

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (!canResolveStatuses.has(existing.status)) {
        throw unprocessable("Only pending or revision requested approvals can be rejected");
      }

      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "rejected",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);

      if (updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return updated;
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
        .orderBy(asc(approvalComments.createdAt));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body,
        })
        .returning()
        .then((rows) => rows[0]);
    },
  };
}
