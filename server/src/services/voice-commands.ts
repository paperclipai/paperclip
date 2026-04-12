import type { Db } from "@paperclipai/db";
import { voiceCommands } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { publishLiveEvent } from "./live-events.js";

export function voiceCommandService(db: Db) {
  async function create(input: {
    companyId: string;
    initiatedByUserId: string;
    rawText: string;
    routerAgentId?: string;
    chatId?: string;
    metadata?: Record<string, unknown>;
    initialStatus?: string;
  }) {
    const [cmd] = await db
      .insert(voiceCommands)
      .values({
        companyId: input.companyId,
        initiatedByUserId: input.initiatedByUserId,
        rawText: input.rawText,
        routerAgentId: input.routerAgentId ?? null,
        chatId: input.chatId ?? null,
        status: input.initialStatus ?? "pending",
        metadata: input.metadata ?? null,
      })
      .returning();

    publishLiveEvent({
      companyId: input.companyId,
      type: "voice.command.created",
      payload: { voiceCommandId: cmd.id, status: cmd.status },
    });

    return cmd;
  }

  async function list(
    companyId: string,
    opts?: {
      initiatedByUserId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const conditions = [eq(voiceCommands.companyId, companyId)];

    if (opts?.initiatedByUserId) {
      conditions.push(eq(voiceCommands.initiatedByUserId, opts.initiatedByUserId));
    }
    if (opts?.status) {
      conditions.push(eq(voiceCommands.status, opts.status));
    }

    const query = db
      .select()
      .from(voiceCommands)
      .where(and(...conditions))
      .orderBy(desc(voiceCommands.createdAt));

    if (opts?.limit) {
      query.limit(opts.limit);
    }
    if (opts?.offset) {
      query.offset(opts.offset);
    }

    return query;
  }

  async function getById(id: string) {
    const [cmd] = await db.select().from(voiceCommands).where(eq(voiceCommands.id, id));
    return cmd ?? null;
  }

  async function get(id: string, companyId: string) {
    const [cmd] = await db
      .select()
      .from(voiceCommands)
      .where(and(eq(voiceCommands.id, id), eq(voiceCommands.companyId, companyId)));
    return cmd ?? null;
  }

  async function update(
    id: string,
    companyId: string,
    updates: {
      classification?: string;
      actionTaken?: string;
      createdIssueId?: string;
      chatId?: string;
      status?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const [updated] = await db
      .update(voiceCommands)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(voiceCommands.id, id), eq(voiceCommands.companyId, companyId)))
      .returning();

    if (updated) {
      publishLiveEvent({
        companyId,
        type: "voice.command.updated",
        payload: {
          voiceCommandId: id,
          status: updated.status,
          classification: updated.classification,
          createdIssueId: updated.createdIssueId,
        },
      });
    }

    return updated ?? null;
  }

  async function addCorrection(
    id: string,
    companyId: string,
    correction: {
      correctionText: string;
      previousClassification: string | null;
      newClassification: string | null;
      previousIssueId: string | null;
      newIssueId: string | null;
      action: string;
    },
  ) {
    const cmd = await get(id, companyId);
    if (!cmd) return null;

    const existing = cmd.correctionHistory ?? [];
    const entry = {
      ...correction,
      correctedAt: new Date().toISOString(),
    };
    const history = [...existing, entry];

    const [updated] = await db
      .update(voiceCommands)
      .set({
        correctionHistory: history as typeof cmd.correctionHistory,
        classification: correction.newClassification ?? cmd.classification,
        createdIssueId: correction.newIssueId ?? cmd.createdIssueId,
        status: "corrected",
        updatedAt: new Date(),
      })
      .where(and(eq(voiceCommands.id, id), eq(voiceCommands.companyId, companyId)))
      .returning();

    if (updated) {
      publishLiveEvent({
        companyId,
        type: "voice.command.corrected",
        payload: {
          voiceCommandId: id,
          correction,
        },
      });
    }

    return updated ?? null;
  }

  async function remove(id: string, companyId: string) {
    const [deleted] = await db
      .delete(voiceCommands)
      .where(and(eq(voiceCommands.id, id), eq(voiceCommands.companyId, companyId)))
      .returning();
    return deleted ?? null;
  }

  async function getProcessingCount(companyId: string) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(voiceCommands)
      .where(and(eq(voiceCommands.companyId, companyId), eq(voiceCommands.status, "processing")));
    return rows[0]?.count ?? 0;
  }

  async function promoteNextQueued(companyId: string) {
    const rows = await db
      .select()
      .from(voiceCommands)
      .where(and(eq(voiceCommands.companyId, companyId), eq(voiceCommands.status, "queued")))
      .orderBy(voiceCommands.createdAt)
      .limit(1);
    const next = rows[0];
    if (!next) return null;

    const [promoted] = await db
      .update(voiceCommands)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(voiceCommands.id, next.id))
      .returning();

    if (promoted) {
      publishLiveEvent({
        companyId,
        type: "voice.command.updated",
        payload: { voiceCommandId: promoted.id, status: "processing" },
      });
    }

    return promoted ?? null;
  }

  async function countByStatus(companyId: string, initiatedByUserId?: string) {
    const conditions = [eq(voiceCommands.companyId, companyId)];
    if (initiatedByUserId) {
      conditions.push(eq(voiceCommands.initiatedByUserId, initiatedByUserId));
    }

    const rows = await db
      .select({
        status: voiceCommands.status,
        count: sql<number>`count(*)::int`,
      })
      .from(voiceCommands)
      .where(and(...conditions))
      .groupBy(voiceCommands.status);

    return rows;
  }

  return {
    create,
    list,
    getById,
    get,
    update,
    remove,
    addCorrection,
    countByStatus,
    getProcessingCount,
    promoteNextQueued,
  };
}
