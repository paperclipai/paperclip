import type { Db } from "@paperclipai/db";
import { getServerAdapter } from "../../adapters/registry.js";
import { calculateModelCostCents } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import type {
  AdapterAgent,
  AdapterRuntime,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "../../adapters/types.js";
import type { BuilderToolDescriptor } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import {
  buildBuilderPrompt,
  parseBuilderResponsePayload,
  type BuilderAdapterMessage as FormatterMessage,
} from "./tool-formatter.js";

/**
 * Builder adapter execution types and utilities.
 *
 * This module bridges the Builder system to the adapter execution layer.
 *
 * Existing adapters are optimized for "run a prompt and return text", not
 * native function-calling APIs. Builder therefore renders the transcript +
 * tool catalog into a strict JSON-only prompt and parses the adapter's final
 * text response back into structured tool calls.
 */

export interface BuilderAdapterConfig {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface ExecuteBuilderTurnInput {
  db: Db;
  sessionId: string;
  companyId: string;
  messages: BuilderAdapterMessage[];
  tools: BuilderToolDescriptor[];
  adapterConfig: BuilderAdapterConfig;
  signal?: AbortSignal;
  authToken?: string;
}

export interface BuilderAdapterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
}

export interface BuilderAdapterResponse {
  /** Free-form assistant text. */
  text: string;
  /** Tool calls the model wants the host to execute. */
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** "stop" if the model is done; "tool_calls" if it wants tools run. */
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage: {
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  };
}

export const BUILDER_SUPPORTED_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "opencode_local",
  "cursor",
  "gemini_local",
  "pi_local",
  "openclaw_gateway",
  "otto_agent",
] as const;

/**
 * Execute a Builder turn via an adapter process (claude, codex, opencode, etc.).
 *
 * This spawns the adapter CLI, injects a Builder-specific prompt, parses the
 * adapter's structured JSON response, and returns it in Builder format.
 *
 * Unlike agent runs, Builder turns are stateless (no session continuity across
 * turns), so we pass an empty runtime and reconstruct the full conversation
 * history in each call.
 */
export async function executeBuilderTurn(
  input: ExecuteBuilderTurnInput,
): Promise<BuilderAdapterResponse> {
  const { db, sessionId, companyId, messages, tools, adapterConfig, signal, authToken } = input;
  const { adapterType, adapterConfig: config } = adapterConfig;

  // Get the adapter from registry (same as agents use)
  const adapter = getServerAdapter(adapterType);
  if (!adapter) {
    throw new Error(
      `Adapter type "${adapterType}" not found. Available adapters: ${BUILDER_SUPPORTED_ADAPTER_TYPES.join(", ")}`,
    );
  }

  // Create minimal AdapterAgent for Builder execution
  // Builder is not a real agent, so we use synthetic values
  const builderAgent: AdapterAgent = {
    id: `builder_${sessionId}`,
    companyId,
    name: "AI Builder",
    adapterType,
    adapterConfig: config,
  };

  // Empty runtime (Builder doesn't use session management)
  const runtime: AdapterRuntime = {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  };

  const builderPrompt = buildBuilderPrompt(messages as FormatterMessage[], tools);
  const builderInvocationId = randomUUID();

  const context: Record<string, unknown> = {
    prompt: builderPrompt,
    executionMode: "builder",
    builderInvocationId,
    builderPrompt,
    builderTools: tools, // Keep original for debugging
    builderMessages: messages, // Keep original for debugging
  };

  const executionConfig = {
    ...config,
    promptTemplate: "{{context.builderPrompt}}",
    bootstrapPromptTemplate: "",
    timeoutSec: 120, // 2 minute timeout for Builder turns
  };

  // Logging handlers
  const logs: { stream: string; line: string }[] = [];
  const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
    logs.push({ stream, line: chunk });
    logger.debug({ stream, chunk }, "Builder adapter output");
  };

  let invocationMeta: AdapterInvocationMeta | null = null;
  const onMeta = async (meta: AdapterInvocationMeta) => {
    invocationMeta = meta;
    logger.debug({ meta }, "Builder adapter invocation metadata");
  };

  // Build execution context
  const executionContext: AdapterExecutionContext = {
    runId: sessionId, // Use sessionId as runId for Builder
    agent: builderAgent,
    runtime,
    config: executionConfig,
    context,
    onLog,
    onMeta,
    authToken: authToken ?? undefined,
  };

  try {
    logger.info({ sessionId, adapterType }, "Executing Builder turn via adapter");
    const result: AdapterExecutionResult = await adapter.execute(executionContext);
    
    logger.info({ 
      sessionId, 
      adapterType,
      exitCode: result.exitCode,
      hasError: !!result.errorMessage,
      hasSummary: !!result.summary,
      summaryLength: result.summary?.length || 0,
    }, "Builder adapter execution completed");

    // Parse adapter result and convert to Builder format
    const model =
      typeof config.model === "string" && config.model.trim().length > 0
        ? config.model.trim()
        : "";
    return parseAdapterResult(result, adapterType, model);
  } catch (error) {
    logger.error({ error, adapterType, sessionId }, "Builder adapter execution failed");
    throw new Error(
      `Adapter execution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parse adapter execution result into Builder response format.
 *
 * Different adapters return results in different formats. This function
 * normalizes them into the Builder's expected structure.
 */
function parseAdapterResult(
  result: AdapterExecutionResult,
  _adapterType: string,
  model: string,
): BuilderAdapterResponse {
  // Check for errors
  if (result.exitCode !== 0 || result.errorMessage) {
    throw new Error(
      result.errorMessage || `Adapter exited with code ${result.exitCode}`,
    );
  }

  // Extract usage
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  const cachedInputTokens = result.usage?.cachedInputTokens ?? 0;
  const costCents =
    typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd > 0
      ? Math.round(result.costUsd * 100)
      : calculateModelCostCents(model, inputTokens, outputTokens, cachedInputTokens);

  const parsed = parseBuilderResponse(result);
  if (parsed) {
    return {
      ...parsed,
      usage: {
        inputTokens,
        outputTokens,
        costCents,
      },
    };
  }

  const text = extractTextFromResult(result);

  return {
    text,
    toolCalls: [],
    finishReason: result.timedOut ? "length" : "stop",
    usage: {
      inputTokens,
      outputTokens,
      costCents,
    },
  };
}

function parseBuilderResponse(
  result: AdapterExecutionResult,
): Omit<BuilderAdapterResponse, "usage"> | null {
  const candidates = [
    result.summary,
    extractStringField(result.resultJson, "stdout"),
    extractStringField(result.resultJson, "text"),
    extractStringField(result.resultJson, "content"),
    extractStringField(result.resultJson, "message"),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = parseBuilderResponsePayload(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function extractTextFromResult(result: AdapterExecutionResult): string {
  // Check summary first (common across all adapters)
  if (result.summary) {
    return result.summary;
  }

  if (result.resultJson && typeof result.resultJson === "object") {
    // OpenAI format: { choices: [{ message: { content: "..." } }] }
    if ("choices" in result.resultJson && Array.isArray(result.resultJson.choices)) {
      const firstChoice = result.resultJson.choices[0];
      if (
        firstChoice &&
        typeof firstChoice === "object" &&
        "message" in firstChoice &&
        firstChoice.message &&
        typeof firstChoice.message === "object" &&
        "content" in firstChoice.message &&
        typeof firstChoice.message.content === "string"
      ) {
        return firstChoice.message.content;
      }
    }

    // Anthropic format: { content: [{ type: "text", text: "..." }] }
    if ("content" in result.resultJson && Array.isArray(result.resultJson.content)) {
      const textBlocks = result.resultJson.content.filter(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block,
      );
      if (textBlocks.length > 0) {
        return textBlocks
          .map((block: { text: unknown }) => String(block.text))
          .join("\n");
      }
    }

    // Generic patterns
    if ("text" in result.resultJson && typeof result.resultJson.text === "string") {
      return result.resultJson.text;
    }
    if ("content" in result.resultJson && typeof result.resultJson.content === "string") {
      return result.resultJson.content;
    }
    if ("message" in result.resultJson && typeof result.resultJson.message === "string") {
      return result.resultJson.message;
    }
  }

  return "";
}

function extractStringField(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = value[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}
