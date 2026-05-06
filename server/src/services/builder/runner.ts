import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type {
  BuilderActor,
  BuilderProviderMessage,
} from "./types.js";
import {
  getBuilderToolCatalog,
  resolveBuilderTool,
  safeRunTool,
} from "./tool-registry.js";
import { builderSessionStore } from "./session-store.js";
import { builderProposalStore } from "./proposal-store.js";
import { recordBuilderCost } from "./cost-bridge.js";
import type { PersistedBuilderMessage } from "./session-store.js";
import {
  executeBuilderTurn,
  type BuilderAdapterConfig,
} from "./adapter-executor.js";

/**
 * Hard caps to keep a runaway LLM from spending the world. Combined with the
 * existing company monthly budget hard-stop, this gives belt + braces
 * protection per `doc/plans/2026-05-04-company-ai-builder.md` §7.
 */
export const BUILDER_MAX_TURNS = 8;
export const BUILDER_MAX_TOOL_CALLS_PER_TURN = 16;
export const BUILDER_MAX_TRANSCRIPT_MESSAGES = 80;

const SYSTEM_PROMPT = `You are the AI Builder for a single Bizbox company. You help a board operator inspect and shape the company's control-plane primitives — agents, goals, projects, issues, routines, budgets.

Rules:
- Stay scoped to the current company.
- Use the provided tools for any factual claim about company state. Do not guess.
- Be concise. Prefer short, structured answers.
- Never reveal API keys, credentials, or raw secret values.
- Mutations are deferred only for these core tools: create_routine, update_routine, create_goal, update_goal, create_issue, update_issue, hire_agent, set_budget, update_company, and grant_access. Those tools create a *proposal* and some also create a linked row in the standard Approvals queue. Tell the operator those changes are pending and will only take effect after they Apply them (or after the linked Approval is decided). Do not assume plugin tools follow this proposal flow unless a tool result explicitly returns a proposalId.
- If no tool fits a request — particularly destructive operations like deleting a company or running arbitrary SQL — say so plainly rather than fabricating tools.`;

function toProviderMessages(persisted: PersistedBuilderMessage[]): BuilderProviderMessage[] {
  const out: BuilderProviderMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const message of persisted) {
    const content = message.content ?? {};
    if (message.role === "user") {
      out.push({ role: "user", content: typeof content.text === "string" ? content.text : "" });
    } else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: typeof content.text === "string" ? content.text : "",
        toolCalls: Array.isArray(content.toolCalls)
          ? content.toolCalls.map((call) => ({
              id: String(call.id ?? ""),
              name: String(call.name ?? ""),
              arguments:
                call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
                  ? (call.arguments as Record<string, unknown>)
                  : {},
            }))
          : undefined,
      });
    } else if (message.role === "tool") {
      const result = content.toolResult;
      out.push({
        role: "tool",
        content: result ? JSON.stringify(result.result ?? null) : "null",
        toolCallId: result?.toolCallId ?? "",
      });
    }
    // system messages from the transcript are ignored — we always supply our own.
  }
  return out;
}

function trimTranscriptForProvider(
  persisted: PersistedBuilderMessage[],
): PersistedBuilderMessage[] {
  if (persisted.length <= BUILDER_MAX_TRANSCRIPT_MESSAGES) return persisted;
  const tail = persisted.slice(-BUILDER_MAX_TRANSCRIPT_MESSAGES);
  const firstUserIdx = tail.findIndex((message) => message.role === "user");
  return firstUserIdx > 0 ? tail.slice(firstUserIdx) : tail;
}

/**
 * Run a single Builder turn: hand the transcript to the adapter, execute any tool
 * calls it emits, feed the results back, repeat until the model stops or we
 * hit the per-turn cap.
 *
 * All persistence happens through `builderSessionStore`; the runner just
 * orchestrates and returns the new messages.
 */
export async function runBuilderTurn(opts: {
  db: Db;
  adapterConfig: BuilderAdapterConfig;
  sessionId: string;
  companyId: string;
  actor: BuilderActor;
  signal?: AbortSignal;
  /** Optional injected store (test-only). Defaults to the real Drizzle-backed store. */
  store?: ReturnType<typeof builderSessionStore>;
  /** Optional injected tool catalog (test-only). Defaults to the registry. */
  toolCatalog?: ReturnType<typeof getBuilderToolCatalog>;
  /** Optional injected proposal store (test-only). */
  proposalStore?: ReturnType<typeof builderProposalStore>;
}) {
  const { db, adapterConfig, sessionId, companyId, actor, signal } = opts;
  const store = opts.store ?? builderSessionStore(db);
  const catalog = opts.toolCatalog ?? getBuilderToolCatalog(db);
  const proposalStore = opts.proposalStore ?? builderProposalStore(db);

  const providerTools = Array.from(catalog.values());

  const newMessages: PersistedBuilderMessage[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  let truncated = false;

  for (let turn = 0; turn < BUILDER_MAX_TURNS; turn += 1) {
    if (signal?.aborted) break;

    const transcript = trimTranscriptForProvider(await store.listMessages(sessionId));
    const providerMessages = toProviderMessages(transcript);

    const response = await executeBuilderTurn({
      db,
      sessionId,
      companyId,
      messages: providerMessages,
      tools: providerTools,
      adapterConfig,
      signal,
    });

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.costCents += response.usage.costCents ?? 0;

    // Record this turn's spend so it rolls up via the existing budget
    // hard-stop logic. Best-effort — failures are logged but do not break
    // the chat loop. Skipped automatically when cost is zero.
    await recordBuilderCost(db, {
      companyId,
      provider: adapterConfig.adapterType,
      model: typeof adapterConfig.adapterConfig.model === "string" 
        ? adapterConfig.adapterConfig.model 
        : "unknown",
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costCents: response.usage.costCents ?? 0,
    });

    // Truncate tool calls if over limit to prevent transcript mismatch
    const calls = response.toolCalls.slice(0, BUILDER_MAX_TOOL_CALLS_PER_TURN);
    if (response.toolCalls.length > BUILDER_MAX_TOOL_CALLS_PER_TURN) {
      logger.warn(
        { sessionId, count: response.toolCalls.length },
        "builder turn truncated: too many tool calls",
      );
      truncated = true;
    }

    const assistantMessage = await store.appendMessage(sessionId, companyId, {
      role: "assistant",
      content: {
        text: response.text,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      },
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costCents: response.usage.costCents ?? 0,
    });
    newMessages.push(assistantMessage);

    if (response.finishReason === "stop" || calls.length === 0) {
      break;
    }

    for (const call of calls) {
      const tool = resolveBuilderTool(catalog, call.name);
      if (!tool) {
        const toolMessage = await store.appendMessage(sessionId, companyId, {
          role: "tool",
          content: {
            toolResult: {
              toolCallId: call.id,
              name: call.name,
              ok: false,
              result: { error: `Unknown tool: ${call.name}` },
            },
          },
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
        });
        newMessages.push(toolMessage);
        continue;
      }

      const result = await safeRunTool(tool, call.arguments, {
        companyId,
        sessionId,
        messageId: assistantMessage.id,
        actor,
        db,
        proposalStore,
      });

      const toolMessage = await store.appendMessage(sessionId, companyId, {
        role: "tool",
        content: {
          toolResult: {
            toolCallId: call.id,
            name: tool.name,
            ok: result.ok,
            result: result.ok ? result.result : { error: result.error },
            ...(result.ok && result.proposalId ? { proposalId: result.proposalId } : {}),
            ...(result.ok && result.activityId ? { activityId: result.activityId } : {}),
          },
        },
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
      });
      newMessages.push(toolMessage);
    }

    if (truncated) break;

    if (turn === BUILDER_MAX_TURNS - 1) {
      truncated = true;
    }
  }

  await store.applyTotals(sessionId, usage);

  return { newMessages, usage, truncated };
}
