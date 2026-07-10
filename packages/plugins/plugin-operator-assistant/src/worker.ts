import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type AgentSessionEvent,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { ASSISTANT_AGENT_KEY, PLUGIN_ID } from "./manifest.js";
import { AgentAnswerAccumulator } from "./agent-output.js";
import { buildGroundedPrompt, retrieveEvidence, type AssistantEvidence } from "./retrieval.js";

type ChatSessionRow = {
  id: string;
  agent_session_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type ChatMessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  run_id: string | null;
  evidence: AssistantEvidence | Record<string, never>;
  created_at: string;
};

function table(ctx: PluginContext, name: "assistant_chat_sessions" | "assistant_chat_messages") {
  return `${ctx.db.namespace}.${name}`;
}

function requiredString(value: unknown, name: string, maxLength = 4_000): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${name} must be ${maxLength} characters or fewer`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function streamChannel(chatSessionId: string) {
  return `operator-assistant:${chatSessionId}`;
}

function terminalEvent(event: AgentSessionEvent) {
  return event.eventType === "done" || event.eventType === "error";
}

async function loadChatState(ctx: PluginContext, companyId: string, requestedSessionId?: string | null) {
  const sessions = await ctx.db.query<ChatSessionRow>(
    requestedSessionId
      ? `SELECT id, agent_session_id, title, status, created_at::text, updated_at::text
           FROM ${table(ctx, "assistant_chat_sessions")}
          WHERE company_id = $1 AND id = $2
          LIMIT 1`
      : `SELECT id, agent_session_id, title, status, created_at::text, updated_at::text
           FROM ${table(ctx, "assistant_chat_sessions")}
          WHERE company_id = $1 AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 1`,
    requestedSessionId ? [companyId, requestedSessionId] : [companyId],
  );
  const session = sessions[0] ?? null;
  const messages = session
    ? await ctx.db.query<ChatMessageRow>(
        `SELECT id, role, content, run_id, evidence, created_at::text
           FROM ${table(ctx, "assistant_chat_messages")}
          WHERE company_id = $1 AND chat_session_id = $2
          ORDER BY created_at ASC
          LIMIT 100`,
        [companyId, session.id],
      )
    : [];
  return { session, messages };
}

async function createChat(ctx: PluginContext, companyId: string) {
  const resolution = await ctx.agents.managed.reconcile(ASSISTANT_AGENT_KEY, companyId);
  const agent = resolution.agent;
  if (!agent || !resolution.agentId) {
    throw new Error("The Operator Assistant agent could not be provisioned for this company.");
  }
  if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
    throw new Error(`The Operator Assistant agent cannot chat while its status is ${agent.status}.`);
  }

  const id = randomUUID();
  const agentSession = await ctx.agents.sessions.create(agent.id, companyId, {
    taskKey: `plugin:${PLUGIN_ID}:session:chat:${id}`,
    reason: "Read-only Operator Assistant conversation",
  });
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "assistant_chat_sessions")}
       (id, company_id, agent_session_id, title, status)
     VALUES ($1, $2, $3, 'New conversation', 'active')`,
    [id, companyId, agentSession.sessionId],
  );
  return {
    session: {
      id,
      agent_session_id: agentSession.sessionId,
      title: "New conversation",
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    channel: streamChannel(id),
  };
}

async function persistAssistantMessage(ctx: PluginContext, input: {
  companyId: string;
  chatSessionId: string;
  answer: string;
  runId: string | null;
  evidence: AssistantEvidence;
}) {
  const content = input.answer.trim() || "I could not produce an answer from the available evidence.";
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "assistant_chat_messages")}
       (id, company_id, chat_session_id, role, content, run_id, evidence)
     VALUES ($1, $2, $3, 'assistant', $4, $5, $6::jsonb)`,
    [randomUUID(), input.companyId, input.chatSessionId, content, input.runId, JSON.stringify(input.evidence)],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "assistant_chat_sessions")}
        SET updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [input.companyId, input.chatSessionId],
  );
}

async function sendChatMessage(ctx: PluginContext, input: {
  companyId: string;
  chatSessionId: string;
  question: string;
}) {
  const sessions = await ctx.db.query<ChatSessionRow>(
    `SELECT id, agent_session_id, title, status, created_at::text, updated_at::text
       FROM ${table(ctx, "assistant_chat_sessions")}
      WHERE company_id = $1 AND id = $2 AND status = 'active'
      LIMIT 1`,
    [input.companyId, input.chatSessionId],
  );
  const session = sessions[0];
  if (!session) throw new Error("Chat session not found or no longer active.");

  // Retrieve first so a database/search failure cannot leave a dangling user
  // message with no corresponding assistant response.
  const evidence = await retrieveEvidence(ctx, input.companyId, input.question);
  const questionId = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "assistant_chat_messages")}
       (id, company_id, chat_session_id, role, content)
     VALUES ($1, $2, $3, 'user', $4)`,
    [questionId, input.companyId, input.chatSessionId, input.question],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "assistant_chat_sessions")}
        SET title = CASE WHEN title = 'New conversation' THEN left($3, 72) ELSE title END,
            updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [input.companyId, input.chatSessionId, input.question],
  );

  const prompt = buildGroundedPrompt(input.question, evidence);
  const channel = streamChannel(input.chatSessionId);
  ctx.streams.open(channel, input.companyId);
  ctx.streams.emit(channel, {
    type: "assistant.started",
    chatSessionId: input.chatSessionId,
    questionId,
    window: evidence.window,
  });

  let answer = "";
  const output = new AgentAnswerAccumulator();
  let finalized = false;
  try {
    const sendResult = await ctx.agents.sessions.sendMessage(session.agent_session_id, input.companyId, {
      prompt,
      reason: "Answer a read-only company question from retrieved evidence",
      onEvent: (event) => {
        if (event.eventType === "chunk" && event.stream === "stdout" && event.message) {
          for (const text of output.push(event.message)) {
            const separator = answer ? "\n\n" : "";
            answer += `${separator}${text}`;
            ctx.streams.emit(channel, {
              type: "assistant.agent-event",
              chatSessionId: input.chatSessionId,
              eventType: "chunk",
              stream: "stdout",
              message: `${separator}${text}`,
              runId: event.runId,
              seq: event.seq,
            });
          }
        }
        if (!terminalEvent(event) || finalized) return;
        finalized = true;
        for (const text of output.finish()) {
          answer += `${answer ? "\n\n" : ""}${text}`;
        }
        const failed = event.eventType === "error";
        const finalAnswer = answer.trim() || (failed
          ? `The assistant run failed: ${event.message ?? "unknown error"}`
          : "I could not produce an answer from the available evidence.");
        void persistAssistantMessage(ctx, {
          companyId: input.companyId,
          chatSessionId: input.chatSessionId,
          answer: finalAnswer,
          runId: event.runId,
          evidence,
        }).then(() => {
          ctx.streams.emit(channel, {
            type: failed ? "assistant.error" : "assistant.done",
            chatSessionId: input.chatSessionId,
            runId: event.runId,
            answer: finalAnswer,
            sources: evidence.sources,
            message: failed ? event.message : null,
          });
          ctx.streams.close(channel);
        }).catch((error) => {
          ctx.logger.error("Failed to persist Operator Assistant answer", {
            companyId: input.companyId,
            chatSessionId: input.chatSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          ctx.streams.emit(channel, {
            type: "assistant.error",
            chatSessionId: input.chatSessionId,
            message: "The answer completed but could not be saved.",
          });
          ctx.streams.close(channel);
        });
      },
    });
    return { channel, runId: sendResult.runId, questionId, sources: evidence.sources };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!finalized) {
      finalized = true;
      await persistAssistantMessage(ctx, {
        companyId: input.companyId,
        chatSessionId: input.chatSessionId,
        answer: `The assistant could not start: ${message}`,
        runId: null,
        evidence,
      });
      ctx.streams.emit(channel, {
        type: "assistant.error",
        chatSessionId: input.chatSessionId,
        message,
      });
      ctx.streams.close(channel);
    }
    throw error;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("chat-state", async (params) => {
      if (typeof params.companyId !== "string" || params.companyId.trim().length === 0) {
        return { session: null, messages: [] };
      }
      const companyId = requiredString(params.companyId, "companyId", 100);
      return loadChatState(ctx, companyId, optionalString(params.chatSessionId));
    });

    ctx.actions.register("start-chat", async (params) => {
      const companyId = requiredString(params.companyId, "companyId", 100);
      return createChat(ctx, companyId);
    });

    ctx.actions.register("send-message", async (params) => {
      const companyId = requiredString(params.companyId, "companyId", 100);
      const chatSessionId = requiredString(params.chatSessionId, "chatSessionId", 100);
      const question = requiredString(params.message, "message");
      return sendChatMessage(ctx, { companyId, chatSessionId, question });
    });
  },
});

export default plugin;

runWorker(plugin, import.meta.url);
