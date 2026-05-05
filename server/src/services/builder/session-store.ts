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
  BuilderProviderType,
  BuilderProposalStatus,
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
    providerType: row.providerType as BuilderProviderType,
    model: row.model,
    state: row.state as BuilderSessionState,
    inputTokensTotal: row.inputTokensTotal,
    outputTokensTotal: row.outputTokensTotal,
    costCentsTotal: row.costCentsTotal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: MessageRow, proposalStatusMap?: Map<string, BuilderProposalStatus>): BuilderMessage {
  const raw = (row.content ?? {}) as Record<string, unknown>;
  const content: BuilderMessageContent = {};
  if (typeof raw.text === "string") content.text = raw.text;
  if (Array.isArray(raw.toolCalls)) content.toolCalls = raw.toolCalls as BuilderMessageContent["toolCalls"];
  if (raw.toolResult && typeof raw.toolResult === "object") {
    const toolResult = raw.toolResult as BuilderMessageContent["toolResult"];
    content.toolResult = toolResult;
    // Attach proposal status if available
    if (toolResult?.proposalId && proposalStatusMap) {
      const status = proposalStatusMap.get(toolResult.proposalId);
      if (status && content.toolResult) {
        content.toolResult = { ...content.toolResult, proposalStatus: status };
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
    listSessions: async (companyId: string): Promise<BuilderSession[]> => {
      const rows = await db
        .select()
        .from(builderSessions)
        .where(eq(builderSessions.companyId, companyId))
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
      
      const proposalStatusMap = new Map<string, BuilderProposalStatus>(
        proposals.map((p) => [p.id, p.status as BuilderProposalStatus])
      );
      
      return { 
        ...toSession(session), 
        messages: messages.map((msg) => toMessage(msg, proposalStatusMap))
      };
    },

    listMessages: async (sessionId: string): Promise<BuilderMessage[]> => {
      const rows = await db
        .select()
        .from(builderMessages)
        .where(eq(builderMessages.sessionId, sessionId))
        .orderBy(asc(builderMessages.sequence));
      
      // Fetch proposals to include status in toolResults
      const proposals = await db
        .select()
        .from(builderProposals)
        .where(eq(builderProposals.sessionId, sessionId));
      
      const proposalStatusMap = new Map<string, BuilderProposalStatus>(
        proposals.map((p) => [p.id, p.status as BuilderProposalStatus])
      );
      
      return rows.map((msg) => toMessage(msg, proposalStatusMap));
    },

    createSession: async (input: {
      companyId: string;
      createdByUserId: string | null;
      title: string;
      providerType: BuilderProviderType;
      model: string;
    }): Promise<BuilderSession> => {
      const [row] = await db
        .insert(builderSessions)
        .values({
          companyId: input.companyId,
          createdByUserId: input.createdByUserId,
          title: input.title,
          providerType: input.providerType,
          model: input.model,
          state: "active",
        })
        .returning();
      return toSession(row);
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

    appendMessage: async (
      sessionId: string,
      companyId: string,
      input: AppendMessageInput,
    ): Promise<BuilderMessage> => {
      // Retry loop for sequence race: if two concurrent requests compute same
      // next value, one insert succeeds, other hits unique constraint violation.
      // Retry with fresh max once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const last = await db
          .select({ sequence: builderMessages.sequence })
          .from(builderMessages)
          .where(eq(builderMessages.sessionId, sessionId))
          .orderBy(desc(builderMessages.sequence))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const sequence = (last?.sequence ?? -1) + 1;
        try {
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
        } catch (err) {
          // Unique constraint violation on (session_id, sequence) → retry once
          if (
            attempt === 0 &&
            err instanceof Error &&
            "code" in err &&
            err.code === "23505"
          ) {
            continue;
          }
          throw err;
        }
      }
      throw new Error("Failed to append message after retry");
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
