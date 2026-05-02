import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatMessages, chatSessions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { badRequest, forbidden, notFound, HttpError } from "../errors.js";
import {
  CHAT_TOOLS,
  executeChatTool,
  listChatToolSpecs,
  resolveDefaultCompanyId,
  type ToolActor,
  type ToolContext,
} from "./chat-tools.js";
import { chatPermissions } from "./chat-permissions.js";
import {
  getProviderForModel,
  listAvailableModels,
  listConfiguredProviders,
  pickBestDefaultModel,
  type CanonicalContentBlock,
  type CanonicalMessage,
} from "./chat-providers.js";

const MAX_TOOL_LOOPS = 12;

export type ChatMode = "chat" | "agent";
export type PermissionMode = "ask" | "bypass";
export type EffortLevel = "auto" | "low" | "medium" | "high";

export interface ChatSession {
  id: string;
  boardUserId: string;
  companyId: string | null;
  title: string;
  model: string;
  mode: ChatMode;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  adapterSessionParams: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: unknown;
  createdAt: string;
}

export type StreamEvent =
  | { type: "session_state"; session: ChatSession }
  | { type: "message_started"; messageId: string; role: "assistant" }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_use_block";
      toolUseId: string;
      name: string;
      input: unknown;
      mutating: boolean;
    }
  | { type: "permission_required"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result_block"; toolUseId: string; ok: boolean; result: unknown }
  | { type: "message_completed"; messageId: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; error: string; code?: string };

function rowToSession(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    boardUserId: row.boardUserId,
    companyId: row.companyId,
    title: row.title,
    model: row.model,
    mode: row.mode as ChatMode,
    permissionMode: row.permissionMode as PermissionMode,
    effort: row.effort as EffortLevel,
    adapterSessionParams: row.adapterSessionParams ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as "user" | "assistant" | "tool",
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ChatActor extends ToolActor {}

function systemPromptFor(session: ChatSession, defaultCompanyId: string | null): string {
  const lines = [
    "You are Clippy, Paperclip's in-app assistant for board users. You can help the user understand the state of their Paperclip companies and, when in agent mode, take actions on their behalf via tools.",
    "Be concise. Prefer short, direct answers. When you call a tool, briefly say what you are about to do.",
  ];
  if (session.mode === "agent") {
    lines.push(
      "You have access to tools that read and (when permitted) modify Paperclip state. Mutating tools may require the user to approve each call. If the user denies a tool, acknowledge it and stop.",
    );
  } else {
    lines.push(
      "You are in chat mode and have no tools. If the user asks you to do something that would require a tool, tell them to switch to Agent mode in the composer.",
    );
  }
  if (defaultCompanyId) {
    lines.push(`Current company id (default for tools that take companyId): ${defaultCompanyId}`);
  } else {
    lines.push(
      "There is no current company selected. Ask the user which company they mean before calling tools that need a companyId.",
    );
  }
  return lines.join("\n\n");
}

function buildCanonicalMessages(messages: ChatMessage[]): CanonicalMessage[] {
  // chat_messages.content stores Anthropic-shape blocks already.
  // user messages map directly. tool_result messages (stored under role 'tool')
  // map to Anthropic's "user with tool_result blocks" convention.
  return messages.map((msg): CanonicalMessage => {
    if (msg.role === "tool") {
      return { role: "user", content: msg.content as CanonicalContentBlock[] };
    }
    return {
      role: msg.role,
      content: msg.content as CanonicalContentBlock[] | string,
    };
  });
}

export function chatService(db: Db) {
  async function listSessions(actor: ChatActor) {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.boardUserId, actor.userId))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(100);
    return rows.map(rowToSession);
  }

  async function getSession(actor: ChatActor, id: string) {
    const row = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, id))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Chat session ${id} not found`);
    if (row.boardUserId !== actor.userId) throw forbidden("Not your chat session");
    return rowToSession(row);
  }

  async function createSession(
    actor: ChatActor,
    input: {
      title?: string;
      companyId?: string | null;
      mode?: ChatMode;
      permissionMode?: PermissionMode;
      model?: string;
    },
  ) {
    // Auto-pick the best available model when the caller didn't specify one,
    // so a fresh chat lands on something that actually works for this user
    // (e.g. claude_local Opus via Claude Pro auth) rather than a hardcoded
    // model that requires an API key they may not have set.
    const initialModel = input.model ?? (await pickBestDefaultModel());
    const created = await db
      .insert(chatSessions)
      .values({
        boardUserId: actor.userId,
        companyId: input.companyId ?? null,
        title: input.title?.slice(0, 200) ?? "New chat",
        mode: input.mode ?? "chat",
        permissionMode: input.permissionMode ?? "ask",
        model: initialModel,
      })
      .returning()
      .then((rows) => rows[0]);
    return rowToSession(created);
  }

  async function updateSession(
    actor: ChatActor,
    id: string,
    patch: {
      title?: string;
      mode?: ChatMode;
      permissionMode?: PermissionMode;
      effort?: EffortLevel;
      companyId?: string | null;
      model?: string;
    },
  ) {
    await getSession(actor, id);
    const updates: Partial<typeof chatSessions.$inferInsert> = { updatedAt: new Date() };
    if (patch.title !== undefined) updates.title = patch.title.slice(0, 200);
    if (patch.mode !== undefined) updates.mode = patch.mode;
    if (patch.permissionMode !== undefined) updates.permissionMode = patch.permissionMode;
    if (patch.effort !== undefined) updates.effort = patch.effort;
    if (patch.companyId !== undefined) updates.companyId = patch.companyId;
    if (patch.model !== undefined) updates.model = patch.model;
    const updated = await db
      .update(chatSessions)
      .set(updates)
      .where(eq(chatSessions.id, id))
      .returning()
      .then((rows) => rows[0]);
    return rowToSession(updated);
  }

  async function deleteSession(actor: ChatActor, id: string) {
    await getSession(actor, id);
    await db.delete(chatSessions).where(eq(chatSessions.id, id));
  }

  async function listMessages(actor: ChatActor, sessionId: string) {
    await getSession(actor, sessionId);
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt));
    return rows.map(rowToMessage);
  }

  async function appendUserMessage(sessionId: string, text: string) {
    const created = await db
      .insert(chatMessages)
      .values({
        sessionId,
        role: "user",
        content: [{ type: "text", text }],
      })
      .returning()
      .then((rows) => rows[0]);
    await db
      .update(chatSessions)
      .set({ updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));
    return rowToMessage(created);
  }

  async function appendAssistantMessage(sessionId: string, blocks: CanonicalContentBlock[]) {
    const created = await db
      .insert(chatMessages)
      .values({ sessionId, role: "assistant", content: blocks })
      .returning()
      .then((rows) => rows[0]);
    return rowToMessage(created);
  }

  async function appendToolResults(sessionId: string, blocks: CanonicalContentBlock[]) {
    const created = await db
      .insert(chatMessages)
      .values({ sessionId, role: "tool", content: blocks })
      .returning()
      .then((rows) => rows[0]);
    return rowToMessage(created);
  }

  async function* runTurn(
    actor: ChatActor,
    sessionId: string,
    userText: string,
    onAbort?: (cb: () => void) => void,
  ): AsyncGenerator<StreamEvent, void, void> {
    let session = await getSession(actor, sessionId);
    const provider = getProviderForModel(session.model);
    if (!provider) {
      const available = await listAvailableModels();
      yield {
        type: "error",
        error: `No provider supports model "${session.model}". Available: ${
          available.map((m) => m.model).join(", ")
            || "(none — set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or start a local Ollama)"
        }`,
        code: "unsupported_model",
      };
      return;
    }
    if (!provider.isConfigured()) {
      const help =
        provider.name === "anthropic"
          ? "Set ANTHROPIC_API_KEY in your environment (or, if you use Claude Pro via the claude_local adapter, that integration is on the roadmap and not yet wired into Clippy)."
          : provider.name === "openai"
            ? "Set OPENAI_API_KEY in your environment."
            : provider.name === "gemini"
              ? "Set GEMINI_API_KEY (or GOOGLE_API_KEY) in your environment."
              : "Start a local Ollama (https://ollama.com) — it'll be auto-detected at 127.0.0.1:11434, or set OLLAMA_HOST to point elsewhere.";
      yield {
        type: "error",
        error: `${provider.name} provider is not configured. ${help}`,
        code: "missing_api_key",
      };
      return;
    }
    const defaultCompanyId = await resolveDefaultCompanyId(db, actor, session.companyId);
    yield { type: "session_state", session };

    await appendUserMessage(sessionId, userText);

    let aborted = false;
    onAbort?.(() => {
      aborted = true;
      chatPermissions.cancelSession(sessionId);
    });

    const toolCtx: ToolContext = { db, actor, defaultCompanyId };
    const tools = session.mode === "agent" ? listChatToolSpecs() : undefined;

    let loops = 0;
    while (loops < MAX_TOOL_LOOPS && !aborted) {
      loops += 1;
      const allMessages = await listMessages(actor, sessionId);
      const turnStream = provider.streamTurn({
        model: session.model,
        system: systemPromptFor(session, defaultCompanyId),
        messages: buildCanonicalMessages(allMessages),
        tools,
        // Adapter-execute providers use this to resume their own session
        // (e.g. Claude Code session id) and persist updated params after each turn.
        adapterContext: {
          sessionId: session.id,
          companyId: session.companyId,
          boardUserId: session.boardUserId,
          prevSessionParams: session.adapterSessionParams,
          saveSessionParams: async (params) => {
            await db
              .update(chatSessions)
              .set({ adapterSessionParams: params, updatedAt: new Date() })
              .where(eq(chatSessions.id, session.id));
            session = { ...session, adapterSessionParams: params };
          },
        },
      });

      const messageStartedAt = new Date();
      yield { type: "message_started", messageId: `pending-${messageStartedAt.getTime()}`, role: "assistant" };

      let result;
      try {
        while (true) {
          const next = await turnStream.next();
          if (next.done) {
            result = next.value;
            break;
          }
          if (aborted) break;
          const event = next.value;
          if (event.type === "text_delta") {
            yield event;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, sessionId, provider: provider.name }, "Chat provider stream errored");
        yield { type: "error", error: message };
        return;
      }
      if (aborted || !result) return;

      const persisted = await appendAssistantMessage(sessionId, result.content);
      yield { type: "message_completed", messageId: persisted.id };

      const toolUseBlocks = result.content.filter(
        (b): b is Extract<CanonicalContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0 || result.stopReason !== "tool_use") {
        yield { type: "done", stopReason: result.stopReason };
        return;
      }

      const toolResults: CanonicalContentBlock[] = [];
      for (const block of toolUseBlocks) {
        if (aborted) return;
        const def = CHAT_TOOLS.find((t) => t.name === block.name);
        const mutating = def?.mutating ?? false;
        yield {
          type: "tool_use_block",
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          mutating,
        };

        let approved: boolean = !mutating || session.permissionMode === "bypass";
        if (mutating && session.permissionMode === "ask") {
          yield {
            type: "permission_required",
            toolUseId: block.id,
            name: block.name,
            input: block.input,
          };
          const decision = await chatPermissions.await(block.id, sessionId);
          approved = decision === "approve";
        }

        if (aborted) return;

        if (!approved) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: "User denied this action.",
          });
          yield {
            type: "tool_result_block",
            toolUseId: block.id,
            ok: false,
            result: { error: "User denied this action." },
          };
          continue;
        }

        const outcome = await executeChatTool(block.name, block.input, toolCtx);
        if (outcome.ok) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(outcome.result),
          });
          yield {
            type: "tool_result_block",
            toolUseId: block.id,
            ok: true,
            result: outcome.result,
          };
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: outcome.error,
          });
          yield {
            type: "tool_result_block",
            toolUseId: block.id,
            ok: false,
            result: { error: outcome.error },
          };
        }
      }

      await appendToolResults(sessionId, toolResults);
      session = await getSession(actor, sessionId);
    }

    if (loops >= MAX_TOOL_LOOPS) {
      yield {
        type: "error",
        error: `Tool loop exceeded max iterations (${MAX_TOOL_LOOPS}). Stopping to avoid runaway.`,
      };
    }
  }

  async function resolvePermission(
    actor: ChatActor,
    sessionId: string,
    toolUseId: string,
    decision: "approve" | "deny",
  ) {
    await getSession(actor, sessionId);
    const ok = chatPermissions.resolve(toolUseId, decision);
    if (!ok) throw notFound("No pending permission for this tool use");
  }

  function getMissingApiKeyError(): HttpError | null {
    if (listConfiguredProviders().length === 0) {
      return badRequest(
        "No LLM provider is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or start a local Ollama (OLLAMA_HOST).",
      );
    }
    return null;
  }

  async function listModels() {
    return listAvailableModels();
  }

  return {
    listSessions,
    getSession,
    createSession,
    updateSession,
    deleteSession,
    listMessages,
    runTurn,
    resolvePermission,
    getMissingApiKeyError,
    listModels,
  };
}

export type ChatService = ReturnType<typeof chatService>;
