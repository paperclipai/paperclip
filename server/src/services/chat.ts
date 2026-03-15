import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatMessages, chatSessions } from "@paperclipai/db";
import type {
  ChatMessage,
  ChatMessageRole,
  ChatSession,
  CreateChatMessageResponse,
  CreateChatSessionResponse,
} from "@paperclipai/shared";
import type { StdoutLineParser, TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { parseCursorStdoutLine } from "@paperclipai/adapter-cursor-local/ui";
import { parseOpenCodeStdoutLine } from "@paperclipai/adapter-opencode-local/ui";
import { parsePiStdoutLine } from "@paperclipai/adapter-pi-local/ui";
import { parseOpenClawGatewayStdoutLine } from "@paperclipai/adapter-openclaw-gateway/ui";
import { conflict, notFound } from "../errors.js";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";

type ChatLogChunk = {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
};

type StreamEventHandlers = {
  onReady?: (payload: { runId: string }) => Promise<void> | void;
  onLog?: (payload: ChatLogChunk) => Promise<void> | void;
  onComplete?: (payload: {
    runId: string;
    status: string;
    message: ChatMessage | null;
  }) => Promise<void> | void;
};

type ChatMessageRow = typeof chatMessages.$inferSelect;
type ChatSessionRow = typeof chatSessions.$inferSelect;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalRunStatus(status: string | null | undefined) {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

function normalizeChatRole(role: string): ChatMessageRole {
  return role === "assistant" ? "assistant" : "user";
}

function normalizeChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    ...row,
    role: normalizeChatRole(row.role),
  };
}

function normalizeChatSession(row: ChatSessionRow): ChatSession {
  return row;
}

function resolveStdoutParser(adapterType: string | null | undefined): StdoutLineParser {
  switch (adapterType) {
    case "claude_local":
      return parseClaudeStdoutLine;
    case "codex_local":
      return parseCodexStdoutLine;
    case "cursor":
      return parseCursorStdoutLine;
    case "opencode_local":
      return parseOpenCodeStdoutLine;
    case "pi_local":
      return parsePiStdoutLine;
    case "openclaw_gateway":
      return parseOpenClawGatewayStdoutLine;
    default:
      return (line, ts) => [{ kind: "stdout", ts, text: line }];
  }
}

function appendTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry) {
  if ((entry.kind === "thinking" || entry.kind === "assistant") && entry.delta) {
    const last = entries[entries.length - 1];
    if (last && last.kind === entry.kind && last.delta) {
      last.text += entry.text;
      last.ts = entry.ts;
      return;
    }
  }
  entries.push(entry);
}

function buildTranscript(chunks: ChatLogChunk[], parser: StdoutLineParser): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let stdoutBuffer = "";

  for (const chunk of chunks) {
    if (chunk.stream === "stderr") {
      entries.push({ kind: "stderr", ts: chunk.ts, text: chunk.chunk });
      continue;
    }
    if (chunk.stream === "system") {
      entries.push({ kind: "system", ts: chunk.ts, text: chunk.chunk });
      continue;
    }

    const combined = stdoutBuffer + chunk.chunk;
    const lines = combined.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const entry of parser(trimmed, chunk.ts)) {
        appendTranscriptEntry(entries, entry);
      }
    }
  }

  const trailing = stdoutBuffer.trim();
  if (trailing) {
    const ts = chunks.length > 0 ? chunks[chunks.length - 1]!.ts : new Date().toISOString();
    for (const entry of parser(trailing, ts)) {
      appendTranscriptEntry(entries, entry);
    }
  }

  return entries;
}

function parseLogLines(input: string, pending: string) {
  const combined = pending + input;
  const lines = combined.split("\n");
  const remainder = lines.pop() ?? "";
  const chunks: ChatLogChunk[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ChatLogChunk;
      if (
        parsed &&
        typeof parsed.ts === "string" &&
        (parsed.stream === "stdout" || parsed.stream === "stderr" || parsed.stream === "system") &&
        typeof parsed.chunk === "string"
      ) {
        chunks.push(parsed);
      }
    } catch {
      // Ignore malformed lines in the live stream.
    }
  }

  return { chunks, remainder };
}

function buildAssistantReply(entries: TranscriptEntry[], run: { status: string; error: string | null }) {
  const assistantText = entries
    .filter((entry): entry is Extract<TranscriptEntry, { kind: "assistant" }> => entry.kind === "assistant")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (assistantText) return assistantText;

  if (run.status === "failed") {
    return run.error?.trim() ? `Run failed: ${run.error.trim()}` : "Run failed before producing a response.";
  }
  if (run.status === "timed_out") {
    return "Run timed out before producing a response.";
  }
  if (run.status === "cancelled") {
    return "Run was cancelled before producing a response.";
  }

  return "";
}

export function chatService(db: Db) {
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);

  async function getSession(sessionId: string) {
    return db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .then((rows) => rows[0] ?? null);
  }

  async function updateSessionActivity(input: {
    sessionId: string;
    lastMessageAt?: Date;
    lastRunId?: string | null;
  }) {
    const patch: Partial<typeof chatSessions.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.lastMessageAt) patch.lastMessageAt = input.lastMessageAt;
    if (typeof input.lastRunId !== "undefined") patch.lastRunId = input.lastRunId;
    await db.update(chatSessions).set(patch).where(eq(chatSessions.id, input.sessionId));
  }

  async function getDefaultSessionForAgent(agentId: string) {
    return db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.agentId, agentId), isNull(chatSessions.archivedAt)))
      .orderBy(desc(chatSessions.updatedAt))
      .then((rows) => rows[0] ?? null);
  }

  async function getOrCreateDefaultSessionForAgent(input: {
    agentId: string;
    companyId: string;
  }) {
    const existing = await getDefaultSessionForAgent(input.agentId);
    if (existing) return existing;
    const sessionId = randomUUID();
    const [created] = await db
      .insert(chatSessions)
      .values({
        id: sessionId,
        companyId: input.companyId,
        agentId: input.agentId,
        taskKey: `chat:${sessionId}`,
        title: "General chat",
      })
      .returning();
    if (!created) throw conflict("Failed to create chat session");
    return created;
  }

  async function resolveSessionForMessageInput(input: {
    agentId: string;
    companyId: string;
    sessionId?: string | null;
  }) {
    if (input.sessionId) {
      const session = await getSession(input.sessionId);
      if (!session || session.agentId !== input.agentId || session.companyId !== input.companyId) {
        throw notFound("Chat session not found");
      }
      if (session.archivedAt) {
        throw conflict("Chat session is archived");
      }
      return session;
    }
    return getOrCreateDefaultSessionForAgent({
      agentId: input.agentId,
      companyId: input.companyId,
    });
  }

  async function getMessage(messageId: string) {
    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadRunLogChunks(runId: string) {
    let offset = 0;
    let remainder = "";
    const chunks: ChatLogChunk[] = [];

    while (true) {
      const log = await heartbeat.readLog(runId, { offset, limitBytes: 256_000 }).catch(() => null);
      if (!log) break;

      const { chunks: parsed, remainder: nextRemainder } = parseLogLines(log.content, remainder);
      chunks.push(...parsed);
      remainder = nextRemainder;
      offset += Buffer.byteLength(log.content, "utf8");

      if (!log.nextOffset) break;
    }

    return chunks;
  }

  async function ensureAssistantMessageForRun(sourceMessageId: string) {
    const sourceMessage = await getMessage(sourceMessageId);
    if (!sourceMessage) throw notFound("Chat message not found");
    if (!sourceMessage.runId) return null;

    const existing = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.agentId, sourceMessage.agentId),
          eq(chatMessages.runId, sourceMessage.runId),
          eq(chatMessages.role, "assistant"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return normalizeChatMessage(existing);

    const run = await heartbeat.getRun(sourceMessage.runId);
    if (!run || !isTerminalRunStatus(run.status)) return null;

    const agent = await agents.getById(sourceMessage.agentId);
    if (!agent) return null;

    const chunks = await loadRunLogChunks(run.id);
    const transcript = buildTranscript(chunks, resolveStdoutParser(agent.adapterType));
    const content = buildAssistantReply(transcript, run);
    if (!content) return null;

    const [assistantMessage] = await db
      .insert(chatMessages)
      .values({
        companyId: sourceMessage.companyId,
        agentId: sourceMessage.agentId,
        chatSessionId: sourceMessage.chatSessionId,
        role: "assistant",
        content,
        runId: run.id,
      })
      .returning();

    if (assistantMessage?.chatSessionId) {
      await updateSessionActivity({
        sessionId: assistantMessage.chatSessionId,
        lastMessageAt: assistantMessage.createdAt,
        lastRunId: run.id,
      });
    }

    return assistantMessage ? normalizeChatMessage(assistantMessage) : null;
  }

  async function reconcileAssistantMessages(sessionId: string, rows: ChatMessage[]) {
    const assistantRunIds = new Set(
      rows
        .filter((row) => row.role === "assistant" && typeof row.runId === "string" && row.runId.length > 0)
        .map((row) => row.runId as string),
    );

    let inserted = false;
    for (const row of rows) {
      if (row.role !== "user" || !row.runId || assistantRunIds.has(row.runId)) continue;
      const assistant = await ensureAssistantMessageForRun(row.id);
      if (assistant) {
        inserted = true;
        assistantRunIds.add(row.runId);
      }
    }

    if (!inserted) return rows;

    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatSessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt))
      .then((items) => items.map(normalizeChatMessage));
  }

  return {
    listSessions: async (agentId: string, opts?: { includeArchived?: boolean }) => {
      const includeArchived = opts?.includeArchived ?? false;
      const query = db
        .select()
        .from(chatSessions)
        .where(
          includeArchived
            ? eq(chatSessions.agentId, agentId)
            : and(eq(chatSessions.agentId, agentId), isNull(chatSessions.archivedAt)),
        )
        .orderBy(desc(chatSessions.updatedAt));
      return query.then((rows) => rows.map(normalizeChatSession));
    },

    getOrCreateDefaultSession: async (agentId: string) => {
      const agent = await agents.getById(agentId);
      if (!agent) throw notFound("Agent not found");
      const session = await getOrCreateDefaultSessionForAgent({
        agentId: agent.id,
        companyId: agent.companyId,
      });
      return normalizeChatSession(session);
    },

    createSession: async (input: {
      agentId: string;
      title?: string | null;
      actor: { actorType: "user" | "agent" | "system"; actorId: string | null };
    }): Promise<CreateChatSessionResponse> => {
      const agent = await agents.getById(input.agentId);
      if (!agent) throw notFound("Agent not found");
      const sessionId = randomUUID();
      const [session] = await db
        .insert(chatSessions)
        .values({
          id: sessionId,
          companyId: agent.companyId,
          agentId: agent.id,
          taskKey: `chat:${sessionId}`,
          title: input.title?.trim() ? input.title.trim() : null,
          createdByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
          createdByAgentId: input.actor.actorType === "agent" ? input.actor.actorId : null,
        })
        .returning();
      if (!session) throw conflict("Failed to create chat session");
      return { session: normalizeChatSession(session) };
    },

    updateSession: async (input: {
      agentId: string;
      sessionId: string;
      title?: string | null;
      archived?: boolean;
    }) => {
      const agent = await agents.getById(input.agentId);
      if (!agent) throw notFound("Agent not found");
      const session = await getSession(input.sessionId);
      if (!session || session.agentId !== agent.id || session.companyId !== agent.companyId) {
        throw notFound("Chat session not found");
      }

      const patch: Partial<typeof chatSessions.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (Object.prototype.hasOwnProperty.call(input, "title")) {
        const normalized = input.title?.trim() ?? "";
        patch.title = normalized.length > 0 ? normalized : null;
      }
      if (typeof input.archived === "boolean") {
        patch.archivedAt = input.archived ? new Date() : null;
      }

      const [updated] = await db
        .update(chatSessions)
        .set(patch)
        .where(eq(chatSessions.id, session.id))
        .returning();
      if (!updated) throw conflict("Failed to update chat session");
      return normalizeChatSession(updated);
    },

    listMessages: async (agentId: string, sessionId?: string | null) => {
      const agent = await agents.getById(agentId);
      if (!agent) throw notFound("Agent not found");
      const session = await resolveSessionForMessageInput({
        agentId: agent.id,
        companyId: agent.companyId,
        sessionId,
      });
      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.chatSessionId, session.id))
        .orderBy(asc(chatMessages.createdAt))
        .then((items) => items.map(normalizeChatMessage));
      return reconcileAssistantMessages(session.id, rows);
    },

    getSession,
    getMessage,

    createMessage: async (input: {
      agentId: string;
      sessionId?: string | null;
      content: string;
      actor: { actorType: "user" | "agent" | "system"; actorId: string | null };
    }): Promise<CreateChatMessageResponse> => {
      const agent = await agents.getById(input.agentId);
      if (!agent) throw notFound("Agent not found");
      const session = await resolveSessionForMessageInput({
        agentId: agent.id,
        companyId: agent.companyId,
        sessionId: input.sessionId,
      });

      const [message] = await db
        .insert(chatMessages)
        .values({
          companyId: agent.companyId,
          agentId: agent.id,
          chatSessionId: session.id,
          role: "user",
          content: input.content,
        })
        .returning();

      if (!message) throw conflict("Failed to create chat message");

      try {
        const run = await heartbeat.wakeup(agent.id, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "chat_message",
          payload: {
            chatMessageId: message.id,
            chatSessionId: session.id,
            taskKey: session.taskKey,
          },
          requestedByActorType: input.actor.actorType,
          requestedByActorId: input.actor.actorId,
          contextSnapshot: {
            chatSessionId: session.id,
            taskKey: session.taskKey,
            chatMessageId: message.id,
          },
        });

        if (!run) {
          throw conflict("Agent wakeup was skipped");
        }

        const [updated] = await db
          .update(chatMessages)
          .set({ runId: run.id })
          .where(eq(chatMessages.id, message.id))
          .returning();

        await updateSessionActivity({
          sessionId: session.id,
          lastMessageAt: (updated ?? message).createdAt,
          lastRunId: run.id,
        });

        return {
          message: normalizeChatMessage(updated ?? message),
          runId: run.id,
        };
      } catch (error) {
        await db.delete(chatMessages).where(eq(chatMessages.id, message.id));
        throw error;
      }
    },

    streamMessageResponse: async (
      input: {
        agentId: string;
        sessionId?: string | null;
        messageId: string;
        isClosed: () => boolean;
      } & StreamEventHandlers,
    ) => {
      const sourceMessage = await getMessage(input.messageId);
      if (!sourceMessage || sourceMessage.agentId !== input.agentId) {
        throw notFound("Chat message not found");
      }
      if (input.sessionId && sourceMessage.chatSessionId !== input.sessionId) {
        throw notFound("Chat message not found");
      }
      if (!sourceMessage.runId) {
        throw conflict("Chat message has not started a run");
      }

      await input.onReady?.({ runId: sourceMessage.runId });

      const existingAssistant = await db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.agentId, sourceMessage.agentId),
            eq(chatMessages.runId, sourceMessage.runId),
            eq(chatMessages.role, "assistant"),
          ),
        )
        .then((rows) => {
          const row = rows[0] ?? null;
          return row ? normalizeChatMessage(row) : null;
        });
      if (existingAssistant) {
        const run = await heartbeat.getRun(sourceMessage.runId);
        await input.onComplete?.({
          runId: sourceMessage.runId,
          status: run?.status ?? "succeeded",
          message: existingAssistant,
        });
        return;
      }

      let offset = 0;
      let remainder = "";

      while (!input.isClosed()) {
        const run = await heartbeat.getRun(sourceMessage.runId);
        if (!run) throw notFound("Heartbeat run not found");

        const log = await heartbeat.readLog(run.id, { offset, limitBytes: 64_000 }).catch(() => null);
        if (log && log.content.length > 0) {
          const { chunks, remainder: nextRemainder } = parseLogLines(log.content, remainder);
          remainder = nextRemainder;
          offset += Buffer.byteLength(log.content, "utf8");
          for (const chunk of chunks) {
            await input.onLog?.(chunk);
          }
        }

        if (isTerminalRunStatus(run.status)) {
          const assistant = await ensureAssistantMessageForRun(sourceMessage.id);
          await input.onComplete?.({
            runId: run.id,
            status: run.status,
            message: assistant,
          });
          return;
        }

        await sleep(1000);
      }
    },
  };
}
