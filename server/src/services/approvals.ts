import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveAgentHireApproval } from "../modules/agent-lifecycle/index.js";

import { instanceSettingsService } from "./instance-settings.js";

export function approvalRecords(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string, database: Db = db) {
    const existing = await database
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
    database: Db = db,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id, database);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await database
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

    const latest = await getExistingApproval(id, database);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    getExistingApproval, resolveApproval,
    list: (companyId: string, status?: string, readCondition?: SQL<boolean>) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      if (readCondition) conditions.push(readCondition);
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    // Cancel an open (pending/revision_requested) approval without a board
    // decision — e.g. when its paired agent is terminated during duplicate
    // cleanup. Idempotent: a no-op on already-resolved approvals.
    cancel: async (id: string, reason?: string | null) => {
      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "cancelled",
          decisionNote: reason ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
        .returning()
        .then((rows) => rows[0] ?? null);
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
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
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
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
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
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}

export function approvalService(db: Db) {
  const { getExistingApproval, resolveApproval, ...records } = approvalRecords(db);
  async function reconcileApprovedBuiltInAgent(companyId: string, payload: Record<string, unknown>, database: Db) {
    const sourceBuiltInAgentKey = typeof payload.sourceBuiltInAgentKey === "string" ? payload.sourceBuiltInAgentKey : null;
    if (!sourceBuiltInAgentKey) return;
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(database).ensure(companyId, sourceBuiltInAgentKey);
  }

  async function decide(id: string, status: "approved" | "rejected", userId: string, note?: string | null) {
    const approval = await getExistingApproval(id);
    if (approval.type === "hire_agent") {
      const result = await resolveAgentHireApproval(db, id, status, userId, note);
      if (result.hireApprovedAgentId) {
        await reconcileApprovedBuiltInAgent(result.approval.companyId, result.approval.payload, db);
        await budgetService(db).deliverPendingEnforcement(result.approval.companyId);
        void notifyHireApproved(db, { companyId: result.approval.companyId, agentId: result.hireApprovedAgentId,
          source: "approval", sourceId: id, approvedAt: result.approval.decidedAt ?? new Date() }).catch(() => {});
      }
      return { approval: result.approval, applied: result.applied };
    }
    return resolveApproval(id, status, userId, note);
  }
  return { ...records,
    approve: (id: string, userId: string, note?: string | null) => decide(id, "approved", userId, note),
    reject: (id: string, userId: string, note?: string | null) => decide(id, "rejected", userId, note),
  };
}
