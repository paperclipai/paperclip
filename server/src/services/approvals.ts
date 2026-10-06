import { agentAppearanceSchema } from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";
import { acquireIssueLifecycleFenceInTransaction } from "./issue-lifecycle-fence.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function persistApprovalRevision(
  writer: Pick<Db, "select" | "update">, id: string, decidedByUserId: string,
  decisionNote?: string | null, companyId?: string,
) {
  const existing = await writer.select().from(approvals)
    .where(and(eq(approvals.id, id), companyId === undefined ? undefined : eq(approvals.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!existing) throw notFound("Approval not found");
  if (companyId !== undefined && existing.companyId !== companyId) throw notFound("Approval not found");
  if (existing.status !== "pending") throw unprocessable("Only pending approvals can request revision");
  const now = new Date();
  const updated = await writer.update(approvals).set({
    status: "revision_requested", decidedByUserId, decisionNote: decisionNote ?? null,
    decidedAt: now, updatedAt: now,
  }).where(and(eq(approvals.id, id),
    companyId === undefined ? undefined : eq(approvals.companyId, companyId),
    companyId === undefined ? undefined : eq(approvals.status, "pending"),
  )).returning().then((rows) => rows[0]);
  if (companyId !== undefined && !updated) throw unprocessable("Approval revision lost pending status");
  return updated;
}

// Dark supplied-tx gate participant. Not authenticated decision authority or
// restoration. Caller must take the company protocol before earlier reads/locks.
export async function requestApprovalRevisionInTransaction(tx: Transaction, input: {
  companyId: string; approvalId: string; decidedByUserId: string; decisionNote?: string | null;
}) {
  const { companyId, approvalId, decidedByUserId, decisionNote } = input;
  if (!companyId) throw unprocessable("Lifecycle-fenced approval revision requires companyId");
  await acquireIssueLifecycleFenceInTransaction(tx, companyId);
  return persistApprovalRevision(tx, approvalId, decidedByUserId, decisionNote, companyId);
}

async function persistApprovalCancellation(writer: Pick<Db, "update">, id: string, reason?: string | null, companyId?: string) {
  const now = new Date();
  return writer.update(approvals).set({
    status: "cancelled", decisionNote: reason ?? null, decidedAt: now, updatedAt: now,
  }).where(and(eq(approvals.id, id), inArray(approvals.status, ["pending", "revision_requested"]),
    companyId === undefined ? undefined : eq(approvals.companyId, companyId),
  )).returning().then((rows) => rows[0] ?? null);
}

// Dark participant: cancellation only, not a board decision or issue restoration.
export async function cancelApprovalInTransaction(tx: Transaction, input: {
  companyId: string; approvalId: string; reason?: string | null;
}) {
  const { companyId, approvalId, reason } = input;
  if (!companyId) throw unprocessable("Lifecycle-fenced approval cancellation requires companyId");
  await acquireIssueLifecycleFenceInTransaction(tx, companyId);
  return persistApprovalCancellation(tx, approvalId, reason, companyId);
}

async function persistApprovalResubmission(
  writer: Pick<Db, "select" | "update">, id: string,
  payload?: Record<string, unknown>, companyId?: string,
) {
  const existing = await writer.select().from(approvals)
    .where(and(eq(approvals.id, id), companyId === undefined ? undefined : eq(approvals.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!existing || (companyId !== undefined && existing.companyId !== companyId)) throw notFound("Approval not found");
  if (existing.status !== "revision_requested") throw unprocessable("Only revision requested approvals can be resubmitted");
  const updated = await writer.update(approvals).set({
    status: "pending", payload: payload ?? existing.payload, decisionNote: null,
    decidedByUserId: null, decidedAt: null, updatedAt: new Date(),
  }).where(and(eq(approvals.id, id),
    companyId === undefined ? undefined : eq(approvals.companyId, companyId),
    companyId === undefined ? undefined : eq(approvals.status, "revision_requested"),
  )).returning().then((rows) => rows[0]);
  if (companyId !== undefined && !updated) throw unprocessable("Approval resubmission lost revision requested status");
  return updated;
}

function snapshotResubmissionPayload(payload?: Record<string, unknown>) {
  if (payload == null) return payload;
  const encoded = approvals.payload.mapToDriverValue(payload);
  if (typeof encoded !== "string" || encoded === "null") {
    throw unprocessable("Lifecycle-fenced resubmission requires present non-null encoded JSON payload");
  }
  return approvals.payload.mapFromDriverValue(encoded);
}

// Dark supplied-tx participant. Not authenticated authority or restoration.
export async function resubmitApprovalInTransaction(tx: Transaction, input: {
  companyId: string; approvalId: string; payload?: Record<string, unknown>;
}) {
  const { companyId, approvalId } = input;
  if (!companyId) throw unprocessable("Lifecycle-fenced approval resubmission requires companyId");
  const payload = snapshotResubmissionPayload(input.payload);
  await acquireIssueLifecycleFenceInTransaction(tx, companyId);
  return persistApprovalResubmission(tx, approvalId, payload, companyId);
}

function persistApprovalCreation(writer: Pick<Db, "insert">, companyId: string,
  data: Omit<typeof approvals.$inferInsert, "companyId">,
) {
  return writer.insert(approvals).values({ ...data, companyId }).returning().then((rows) => rows[0]);
}

function snapshotPendingApprovalCreation(data: Omit<typeof approvals.$inferInsert, "companyId">) {
  const allowed = new Set(["type", "payload", "requestedByAgentId", "requestedByUserId", "status"]);
  if (Reflect.ownKeys(data).some((key) => typeof key !== "string" || !allowed.has(key))
    || (data.status !== undefined && data.status !== "pending")) {
    throw unprocessable("Lifecycle-fenced approval creation accepts pending request fields only");
  }
  const { type, requestedByAgentId, requestedByUserId } = data;
  const payload = snapshotResubmissionPayload(data.payload);
  if (payload == null) throw unprocessable("Lifecycle-fenced approval creation requires JSON payload");
  return { type, requestedByAgentId, requestedByUserId, payload, status: "pending" };
}

async function createFencedApproval(db: Db, companyId: string,
  data: Omit<typeof approvals.$inferInsert, "companyId">,
) {
  if (!companyId) throw unprocessable("Lifecycle-fenced approval creation requires companyId");
  const snapshot = snapshotPendingApprovalCreation(data);
  return db.transaction((tx) => createApprovalInTransaction(tx, { companyId, data: snapshot }));
}

// Dark pending gate participant; not authenticated request authority or restoration.
export async function createApprovalInTransaction(tx: Transaction, input: {
  companyId: string; data: Omit<typeof approvals.$inferInsert, "companyId">;
}) {
  const { companyId } = input;
  if (!companyId) throw unprocessable("Lifecycle-fenced approval creation requires companyId");
  const data = snapshotPendingApprovalCreation(input.data);
  await acquireIssueLifecycleFenceInTransaction(tx, companyId);
  const created = await persistApprovalCreation(tx, companyId, data);
  if (!created) throw unprocessable("Lifecycle-fenced approval creation returned no approval");
  return created;
}

async function persistApprovalResolution(
  writer: Pick<Db, "select" | "update">, id: string,
  targetStatus: "approved" | "rejected", decidedByUserId: string,
  decisionNote: string | null | undefined, companyId?: string,
) {
  const getExisting = async () => {
    const row = await writer.select().from(approvals)
      .where(and(eq(approvals.id, id), companyId === undefined ? undefined : eq(approvals.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row || (companyId !== undefined && row.companyId !== companyId)) throw notFound("Approval not found");
    if (companyId !== undefined && row.type === "hire_agent") {
      throw unprocessable("Lifecycle-fenced rejection does not support hire effects");
    }
    return row;
  };
  const existing = await getExisting();
  if (!["pending", "revision_requested"].includes(existing.status)) {
    if (existing.status === targetStatus) return { approval: existing, applied: false };
    throw unprocessable(`Only pending or revision requested approvals can be ${targetStatus}`);
  }
  const now = new Date();
  const updated = await writer.update(approvals).set({
    status: targetStatus, decidedByUserId, decisionNote: decisionNote ?? null,
    decidedAt: now, updatedAt: now,
  }).where(and(eq(approvals.id, id), inArray(approvals.status, ["pending", "revision_requested"]),
    companyId === undefined ? undefined : eq(approvals.companyId, companyId),
  )).returning().then((rows) => rows[0] ?? null);
  if (updated) return { approval: updated, applied: true };
  const latest = await getExisting();
  if (latest.status === targetStatus) return { approval: latest, applied: false };
  throw unprocessable(`Only pending or revision requested approvals can be ${targetStatus}`);
}

// Dark non-hire participant. No authenticated decision authority, hire effects,
// dependent restoration or production opt-in. Caller must fence before prior locks.
export async function rejectApprovalInTransaction(tx: Transaction, input: {
  companyId: string; approvalId: string; decidedByUserId: string; decisionNote?: string | null;
}) {
  const { companyId, approvalId, decidedByUserId, decisionNote } = input;
  if (!companyId) throw unprocessable("Lifecycle-fenced approval rejection requires companyId");
  await acquireIssueLifecycleFenceInTransaction(tx, companyId);
  return persistApprovalResolution(tx, approvalId, "rejected", decidedByUserId, decisionNote, companyId);
}

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
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

  async function reconcileApprovedBuiltInAgent(companyId: string, payload: Record<string, unknown>) {
    const sourceBuiltInAgentKey = typeof payload.sourceBuiltInAgentKey === "string" ? payload.sourceBuiltInAgentKey : null;
    if (!sourceBuiltInAgentKey) return;
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(db).ensure(companyId, sourceBuiltInAgentKey);
  }

  async function resolveApproval(
    id: string, targetStatus: "approved" | "rejected", decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    return persistApprovalResolution(db, id, targetStatus, decidedByUserId, decisionNote);
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

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">,
      options?: { lifecycleFence?: boolean },
    ) => {
      if (options?.lifecycleFence) return createFencedApproval(db, companyId, data);
      return persistApprovalCreation(db, companyId, data);
    },

    // Cancel an open (pending/revision_requested) approval without a board
    // decision — e.g. when its paired agent is terminated during duplicate
    // cleanup. Idempotent: a no-op on already-resolved approvals.
    cancel: async (id: string, reason?: string | null,
      options?: { lifecycleFence?: boolean; companyId?: string },
    ) => {
      if (options?.lifecycleFence) {
        const companyId = options.companyId;
        if (!companyId) throw unprocessable("Lifecycle-fenced approval cancellation requires companyId");
        return db.transaction((tx) => cancelApprovalInTransaction(tx, {
          companyId, approvalId: id, reason,
        }));
      }
      return persistApprovalCancellation(db, id, reason);
    },

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
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
          await agentsSvc.activatePendingApproval(payloadAgentId, payload);
          await reconcileApprovedBuiltInAgent(updated.companyId, payload);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            appearance: payload.appearance == null ? undefined : agentAppearanceSchema.parse(payload.appearance),
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
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null,
      options?: { lifecycleFence?: boolean; companyId?: string },
    ) => {
      if (options?.lifecycleFence) {
        const companyId = options.companyId;
        if (!companyId) throw unprocessable("Lifecycle-fenced approval rejection requires companyId");
        return db.transaction((tx) => rejectApprovalInTransaction(tx, {
          companyId, approvalId: id, decidedByUserId, decisionNote,
        }));
      }
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

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null,
      options?: { lifecycleFence?: boolean; companyId?: string },
    ) => {
      if (options?.lifecycleFence) {
        const companyId = options.companyId;
        if (!companyId) throw unprocessable("Lifecycle-fenced approval revision requires companyId");
        return db.transaction((tx) => requestApprovalRevisionInTransaction(tx, {
          companyId, approvalId: id, decidedByUserId, decisionNote,
        }));
      }
      return persistApprovalRevision(db, id, decidedByUserId, decisionNote);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>,
      options?: { lifecycleFence?: boolean; companyId?: string },
    ) => {
      if (options?.lifecycleFence) {
        const companyId = options.companyId;
        if (!companyId) throw unprocessable("Lifecycle-fenced approval resubmission requires companyId");
        const capturedPayload = snapshotResubmissionPayload(payload);
        return db.transaction((tx) => resubmitApprovalInTransaction(tx, { companyId, approvalId: id, payload: capturedPayload }));
      }
      return persistApprovalResubmission(db, id, payload);
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
