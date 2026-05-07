import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { builderMessages, builderProposals, builderSessions } from "@paperclipai/db";
import type {
  BuilderMessage,
  BuilderMessageContent,
  BuilderMessageRole,
  BuilderSession,
  BuilderSessionDetail,
  BuilderSessionState,
  BuilderProposalStatus,
  BuilderHandoffTarget,
} from "@paperclipai/shared";

/**
 * Persistence helper for Builder sessions and messages.
 *
 * Kept separate from the runner so the runner can be unit-tested without a
 * database, and so route handlers can list/read sessions without going
 * through the LLM.
 */

type SessionRow = typeof builderSessions.$inferSelect;
type MessageRow = typeof builderMessages.$inferSelect;
type ProposalRow = typeof builderProposals.$inferSelect;

export interface PersistedBuilderMessage extends BuilderMessage {}

function toSession(row: SessionRow): BuilderSession {
  return {
    id: row.id,
    companyId: row.companyId,
    createdByUserId: row.createdByUserId,
    title: row.title,
    adapterType: row.adapterType,
    model: row.model,
    state: row.state as BuilderSessionState,
    archivedAt: row.archivedAt,
    inputTokensTotal: row.inputTokensTotal,
    outputTokensTotal: row.outputTokensTotal,
    costCentsTotal: row.costCentsTotal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function approvalHandoff(approvalId: string): BuilderHandoffTarget {
  return {
    kind: "approval",
    label: "Review approval",
    href: `/approvals/${approvalId}`,
    approvalId,
  };
}

function toMessage(
  row: MessageRow,
  proposalInfoMap?: Map<string, { status: BuilderProposalStatus; handoff: BuilderHandoffTarget | null }>,
): BuilderMessage {
  const raw = (row.content ?? {}) as Record<string, unknown>;
  const content: BuilderMessageContent = {};
  if (typeof raw.text === "string") content.text = raw.text;
  if (Array.isArray(raw.toolCalls)) content.toolCalls = raw.toolCalls as BuilderMessageContent["toolCalls"];
  if (raw.toolResult && typeof raw.toolResult === "object") {
    const toolResult = raw.toolResult as BuilderMessageContent["toolResult"];
    content.toolResult = toolResult;
    // Attach proposal status if available
    if (toolResult?.proposalId && proposalInfoMap) {
      const info = proposalInfoMap.get(toolResult.proposalId);
      if (info && content.toolResult) {
        content.toolResult = {
          ...content.toolResult,
          proposalStatus: info.status,
          ...(info.handoff ? { handoff: info.handoff } : {}),
        };
      }
    }
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    companyId: row.companyId,
    sequence: row.sequence,
    role: row.role as BuilderMessageRole,
    content,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costCents: row.costCents,
    createdAt: row.createdAt,
  };
}

export interface AppendMessageInput {
  role: BuilderMessageRole;
  content: BuilderMessageContent;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export function builderSessionStore(db: Db) {
  return {
    listSessions: async (
      companyId: string,
      options?: { includeArchived?: boolean },
    ): Promise<BuilderSession[]> => {
      const rows = await db
        .select()
        .from(builderSessions)
        .where(
          and(
            eq(builderSessions.companyId, companyId),
            options?.includeArchived ? undefined : sql`${builderSessions.archivedAt} IS NULL`,
          ),
        )
        .orderBy(desc(builderSessions.createdAt));
      return rows.map(toSession);
    },

    getSession: async (
      companyId: string,
      sessionId: string,
    ): Promise<BuilderSession | null> => {
      const row = await db
        .select()
        .from(builderSessions)
        .where(
          and(
            eq(builderSessions.id, sessionId),
            eq(builderSessions.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row ? toSession(row) : null;
    },

    getSessionDetail: async (
      companyId: string,
      sessionId: string,
    ): Promise<BuilderSessionDetail | null> => {
      const session = await db
        .select()
        .from(builderSessions)
        .where(
          and(
            eq(builderSessions.id, sessionId),
            eq(builderSessions.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!session) return null;
      
      const messages = await db
        .select()
        .from(builderMessages)
        .where(eq(builderMessages.sessionId, sessionId))
        .orderBy(asc(builderMessages.sequence));
      
      // Fetch all proposals for this session to include status in toolResults
      const proposals = await db
        .select()
        .from(builderProposals)
        .where(eq(builderProposals.sessionId, sessionId));
      
      const proposalInfoMap = new Map<string, { status: BuilderProposalStatus; handoff: BuilderHandoffTarget | null }>(
        proposals.map((p) => [
          p.id,
          {
            status: p.status as BuilderProposalStatus,
            handoff: p.approvalId ? approvalHandoff(p.approvalId) : null,
          },
        ])
      );
      
      return { 
        ...toSession(session), 
        messages: messages.map((msg) => toMessage(msg, proposalInfoMap))
      };
    },

    listMessages: async (sessionId: string): Promise<BuilderMessage[]> => {
      const rows = await db
        .select()
        .from(builderMessages)
        .where(eq(builderMessages.sessionId, sessionId))
        .orderBy(asc(builderMessages.sequence));
      
      return rows.map((msg) => toMessage(msg));
    },

    createSession: async (input: {
      companyId: string;
      createdByUserId: string | null;
      title: string;
      adapterType: string;
      model: string;
    }): Promise<BuilderSession> => {
      const [row] = await db
        .insert(builderSessions)
        .values({
          companyId: input.companyId,
          createdByUserId: input.createdByUserId,
          title: input.title,
          adapterType: input.adapterType,
          model: input.model,
          state: "active",
          archivedAt: null,
        })
        .returning();
      return toSession(row);
    },

    updateSessionTitle: async (
      sessionId: string,
      title: string,
    ): Promise<void> => {
      await db
        .update(builderSessions)
        .set({ title, updatedAt: new Date() })
        .where(eq(builderSessions.id, sessionId));
    },

    setSessionState: async (
      sessionId: string,
      state: BuilderSessionState,
    ): Promise<void> => {
      await db
        .update(builderSessions)
        .set({ state, updatedAt: new Date() })
        .where(eq(builderSessions.id, sessionId));
    },

    archiveSession: async (
      sessionId: string,
      archivedAt: Date = new Date(),
    ): Promise<void> => {
      await db
        .update(builderSessions)
        .set({ archivedAt, updatedAt: archivedAt })
        .where(eq(builderSessions.id, sessionId));
    },

    restoreSession: async (
      sessionId: string,
      restoredAt: Date = new Date(),
    ): Promise<void> => {
      await db
        .update(builderSessions)
        .set({ archivedAt: null, updatedAt: restoredAt })
        .where(eq(builderSessions.id, sessionId));
    },

    appendMessage: async (
      sessionId: string,
      companyId: string,
      input: AppendMessageInput,
    ): Promise<BuilderMessage> => {
      if (typeof db.transaction !== "function") {
        const last = await db
          .select({ sequence: builderMessages.sequence })
          .from(builderMessages)
          .where(eq(builderMessages.sessionId, sessionId))
          .orderBy(desc(builderMessages.sequence))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const sequence = (last?.sequence ?? -1) + 1;
        const [row] = await db
          .insert(builderMessages)
          .values({
            sessionId,
            companyId,
            sequence,
            role: input.role,
            content: input.content as Record<string, unknown>,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            costCents: input.costCents,
          })
          .returning();
        return toMessage(row);
      }
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select 1 from "builder_sessions" where "id" = ${sessionId} for update`,
        );
        const last = await tx
          .select({ sequence: builderMessages.sequence })
          .from(builderMessages)
          .where(eq(builderMessages.sessionId, sessionId))
          .orderBy(desc(builderMessages.sequence))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const sequence = (last?.sequence ?? -1) + 1;
        const [row] = await tx
          .insert(builderMessages)
          .values({
            sessionId,
            companyId,
            sequence,
            role: input.role,
            content: input.content as Record<string, unknown>,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            costCents: input.costCents,
          })
          .returning();
        return toMessage(row);
      });
    },

    applyTotals: async (
      sessionId: string,
      delta: { inputTokens: number; outputTokens: number; costCents: number },
    ): Promise<void> => {
      if (
        delta.inputTokens === 0 &&
        delta.outputTokens === 0 &&
        delta.costCents === 0
      )
        return;
      await db
        .update(builderSessions)
        .set({
          inputTokensTotal: sql`${builderSessions.inputTokensTotal} + ${delta.inputTokens}`,
          outputTokensTotal: sql`${builderSessions.outputTokensTotal} + ${delta.outputTokens}`,
          costCentsTotal: sql`${builderSessions.costCentsTotal} + ${delta.costCents}`,
          updatedAt: new Date(),
        })
        .where(eq(builderSessions.id, sessionId));
    },
  };
}

export type BuilderSessionStore = ReturnType<typeof builderSessionStore>;
