import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { renderTemplate } from "@paperclipai/adapter-utils/server-utils";
import {
  detectModel as detectHermesModel,
  execute as executeHermesCliBase,
} from "hermes-paperclip-adapter/server";
import {
  DEFAULT_ENDPOINT_MODE,
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_HERMES_API_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_SEC,
  HERMES_OBSERVABLE_EVENT_TYPES,
  PROVIDER_OPTIONS,
  TOOL_OUTPUT_MAX_CHARS,
  type HermesEndpointMode,
} from "../shared/constants.js";
import { buildHermesObservablePrompt } from "./prompt.js";

type HermesCliExecute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

const executeHermesCli = executeHermesCliBase as unknown as HermesCliExecute;

interface HermesCapabilities {
  responsesStreaming: boolean;
  chatCompletionsStreaming: boolean;
  toolProgressEvents: boolean;
}

interface StreamState {
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  errors: string[];
  isError: boolean;
  lastResponseId: string | null;
  sessionId: string | null;
  gatewaySessionKey: string | null;
  endpointMode: HermesEndpointMode;
  conversation: string;
}

class HermesAdapterError extends Error {
  code: string;
  status: number | null;
  cliFallbackEligible: boolean;
  transient: boolean;

  constructor(
    message: string,
    input: {
      code: string;
      status?: number | null;
      cliFallbackEligible?: boolean;
      transient?: boolean;
    },
  ) {
    super(message);
    this.name = "HermesAdapterError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.cliFallbackEligible = input.cliFallbackEligible ?? false;
    this.transient = input.transient ?? false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateText(value: string, maxChars = TOOL_OUTPUT_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[${value.length - maxChars} more chars truncated]`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createApiUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${trimmed}${path.slice(3)}`;
  }
  return `${trimmed}${path}`;
}

function normalizeBaseUrl(config: Record<string, unknown>): string {
  const configured = asString(config.hermesApiBaseUrl).trim();
  return configured || DEFAULT_HERMES_API_BASE_URL;
}

function inferProviderFromModel(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;

  const providerPrefix = normalized.includes("/") ? normalized.split("/")[0] : "";
  if (providerPrefix && PROVIDER_OPTIONS.includes(providerPrefix as (typeof PROVIDER_OPTIONS)[number])) {
    return providerPrefix;
  }

  const bare = normalized.includes("/") ? (normalized.split("/").pop() ?? normalized) : normalized;
  if (bare.startsWith("claude")) return "anthropic";
  if (bare.startsWith("gpt-") || bare.startsWith("o1") || bare.startsWith("o3") || bare.startsWith("o4")) {
    return bare.includes("codex") ? "openai-codex" : "openai";
  }
  if (bare.startsWith("kimi")) return "kimi-coding";
  if (bare.startsWith("minimax")) return "minimax";
  if (bare.startsWith("glm")) return "zai";
  return null;
}

function resolveProviderHint(input: {
  explicitProvider: string;
  detectedProvider?: string | null;
  detectedModel?: string | null;
  model: string;
}): string {
  const explicitProvider = input.explicitProvider.trim().toLowerCase();
  if (
    explicitProvider &&
    explicitProvider !== "auto" &&
    PROVIDER_OPTIONS.includes(explicitProvider as (typeof PROVIDER_OPTIONS)[number])
  ) {
    return explicitProvider;
  }

  const detectedProvider = asString(input.detectedProvider).trim().toLowerCase();
  const detectedModel = asString(input.detectedModel).trim().toLowerCase();
  const requestedModel = input.model.trim().toLowerCase();
  if (
    detectedProvider &&
    detectedModel &&
    detectedModel === requestedModel &&
    PROVIDER_OPTIONS.includes(detectedProvider as (typeof PROVIDER_OPTIONS)[number])
  ) {
    return detectedProvider;
  }

  return inferProviderFromModel(input.model) ?? DEFAULT_PROVIDER;
}

function readStreamBody(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

async function readErrorResponse(response: Response): Promise<string> {
  const body = await readStreamBody(response);
  const parsed = safeJsonParse(body);
  const record = asRecord(parsed);
  const errorRecord = asRecord(record?.error);
  return (
    asString(errorRecord?.message).trim() ||
    asString(record?.message).trim() ||
    body.trim() ||
    `${response.status} ${response.statusText}`
  );
}

async function fetchCapabilities(
  baseUrl: string,
  signal: AbortSignal,
): Promise<HermesCapabilities | null> {
  let response: Response;
  try {
    response = await fetch(createApiUrl(baseUrl, "/v1/capabilities"), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal,
    });
  } catch (error) {
    throw new HermesAdapterError(
      `Could not reach Hermes API at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "hermes_api_unreachable",
        cliFallbackEligible: true,
        transient: true,
      },
    );
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new HermesAdapterError(
      `Hermes capabilities probe failed: ${await readErrorResponse(response)}`,
      {
        code: "hermes_capabilities_failed",
        status: response.status,
      },
    );
  }

  const parsed = asRecord(await response.json().catch(() => null));
  const features = asRecord(parsed?.features) ?? {};
  return {
    responsesStreaming: features.responses_streaming === true,
    chatCompletionsStreaming: features.chat_completions_streaming === true,
    toolProgressEvents: features.tool_progress_events === true,
  };
}

function buildSetupHint(baseUrl: string): string {
  return [
    `Hermes API is unavailable at ${baseUrl}.`,
    "Expected probes:",
    `- ${createApiUrl(baseUrl, "/health")}`,
    `- ${createApiUrl(baseUrl, "/v1/capabilities")}`,
    "Suggested local startup:",
    "API_SERVER_ENABLED=1 API_SERVER_PORT=8000 hermes gateway",
  ].join("\n");
}

async function emitJsonEvent(ctx: AdapterExecutionContext, payload: Record<string, unknown>): Promise<void> {
  await ctx.onLog("stdout", `${JSON.stringify(payload)}\n`);
}

async function emitSystemLine(ctx: AdapterExecutionContext, message: string): Promise<void> {
  const normalized = message.startsWith("[hermes]") ? message : `[hermes] ${message}`;
  await ctx.onLog("stdout", normalized.endsWith("\n") ? normalized : `${normalized}\n`);
}

async function emitError(ctx: AdapterExecutionContext, message: string): Promise<void> {
  await emitJsonEvent(ctx, {
    type: HERMES_OBSERVABLE_EVENT_TYPES.error,
    message,
  });
}

function extractToolName(payload: Record<string, unknown>): string {
  return (
    asString(payload.tool).trim() ||
    asString(payload.name).trim() ||
    asString(payload.function_name).trim() ||
    "tool"
  );
}

function extractToolInput(payload: Record<string, unknown>): unknown {
  if (payload.args !== undefined) return payload.args;
  if (payload.arguments !== undefined) {
    const raw = payload.arguments;
    if (typeof raw === "string") return safeJsonParse(raw) ?? raw;
    return raw;
  }
  if (payload.input !== undefined) return payload.input;
  return {};
}

function extractToolOutput(payload: Record<string, unknown>): string {
  const raw =
    payload.result ??
    payload.output ??
    payload.content ??
    payload.text ??
    payload.error;
  return truncateText(stringifyValue(raw));
}

function extractFunctionCallOutput(item: Record<string, unknown>): string {
  const rawOutput = item.output;
  if (typeof rawOutput === "string") return truncateText(rawOutput);
  if (!Array.isArray(rawOutput)) return truncateText(stringifyValue(rawOutput));
  const chunks = rawOutput
    .map((part) => {
      const record = asRecord(part);
      return (
        asString(record?.text) ||
        asString(record?.output_text) ||
        stringifyValue(record ?? part)
      );
    })
    .filter(Boolean);
  return truncateText(chunks.join("\n"));
}

function extractAssistantTextFromResponse(responsePayload: Record<string, unknown>): string {
  const output = Array.isArray(responsePayload.output) ? responsePayload.output : [];
  const textParts: string[] = [];
  for (const itemValue of output) {
    const item = asRecord(itemValue);
    if (!item || item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const contentValue of content) {
      const contentPart = asRecord(contentValue);
      if (!contentPart) continue;
      const text =
        asString(contentPart.text) ||
        asString(contentPart.output_text);
      if (text) textParts.push(text);
    }
  }
  return textParts.join("");
}

function buildConversationKey(ctx: AdapterExecutionContext): string {
  const context = asRecord(ctx.context) ?? {};
  const taskKey =
    asString(ctx.runtime.taskKey).trim() ||
    asString(context.taskId).trim() ||
    asString(context.issueId).trim() ||
    "idle";
  return `paperclip:${ctx.agent.companyId}:${ctx.agent.id}:${taskKey}`;
}

function maybeTimerUnref(handle: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  if ("unref" in handle && typeof handle.unref === "function") {
    handle.unref();
  }
}

function buildHeaders(): Record<string, string> {
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventName: string | null, data: string) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushBlock = async (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || null;
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    await onEvent(eventName, dataLines.join("\n"));
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex >= 0) {
      const block = buffer.slice(0, splitIndex).replace(/\r$/, "");
      buffer = buffer.slice(splitIndex + 2);
      if (block.trim().length > 0) {
        await flushBlock(block);
      }
      splitIndex = buffer.indexOf("\n\n");
    }

    if (done) break;
  }

  const trailing = buffer.trim();
  if (trailing) {
    await flushBlock(trailing);
  }
}

function createToolTracker(debugEvents: boolean) {
  const activeToolNames = new Map<string, string>();
  const anonymousByName = new Map<string, string[]>();
  let syntheticIdCounter = 0;

  const noteMissingId = async (ctx: AdapterExecutionContext, toolName: string, status: string) => {
    if (!debugEvents) return;
    await emitSystemLine(
      ctx,
      `[debug] ${status} tool event for ${toolName} did not include a stable tool call id; generated one.`,
    );
  };

  const getPayloadId = (payload: Record<string, unknown>) =>
    asString(payload.toolCallId).trim() ||
    asString(payload.call_id).trim() ||
    asString(payload.callId).trim() ||
    asString(payload.id).trim();

  return {
    activeToolName(): string | null {
      const last = Array.from(activeToolNames.values()).at(-1);
      return last ?? null;
    },
    async resolveRunningId(ctx: AdapterExecutionContext, payload: Record<string, unknown>): Promise<string> {
      const toolName = extractToolName(payload);
      const explicit = getPayloadId(payload);
      if (explicit) {
        activeToolNames.set(explicit, toolName);
        return explicit;
      }
      syntheticIdCounter += 1;
      const generated = `hermes-tool-${syntheticIdCounter}`;
      activeToolNames.set(generated, toolName);
      const queue = anonymousByName.get(toolName) ?? [];
      queue.push(generated);
      anonymousByName.set(toolName, queue);
      await noteMissingId(ctx, toolName, "running");
      return generated;
    },
    async resolveCompletedId(ctx: AdapterExecutionContext, payload: Record<string, unknown>): Promise<string> {
      const explicit = getPayloadId(payload);
      if (explicit) return explicit;
      const toolName = extractToolName(payload);
      const queue = anonymousByName.get(toolName) ?? [];
      const reused = queue.shift();
      if (queue.length === 0) anonymousByName.delete(toolName);
      if (reused) return reused;
      syntheticIdCounter += 1;
      const generated = `hermes-tool-${syntheticIdCounter}`;
      await noteMissingId(ctx, toolName, "completed");
      return generated;
    },
    setActive(id: string, name: string): void {
      activeToolNames.set(id, name);
    },
    clearActive(id: string): void {
      activeToolNames.delete(id);
    },
    toolName(id: string, fallbackName: string): string {
      return activeToolNames.get(id) ?? fallbackName;
    },
  };
}

async function openStreamingRequest(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new HermesAdapterError(
      `Could not reach Hermes API at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "hermes_api_unreachable",
        cliFallbackEligible: true,
        transient: true,
      },
    );
  }

  if (!response.ok) {
    throw new HermesAdapterError(await readErrorResponse(response), {
      code: "hermes_http_error",
      status: response.status,
      cliFallbackEligible: response.status >= 500,
      transient: response.status >= 500,
    });
  }

  if (!response.body) {
    throw new HermesAdapterError("Hermes API returned no response body for an SSE request.", {
      code: "hermes_missing_stream_body",
      cliFallbackEligible: true,
      transient: true,
    });
  }

  return response;
}

async function executeResponsesStream(input: {
  ctx: AdapterExecutionContext;
  url: string;
  model: string;
  provider: string;
  conversation: string;
  gatewaySessionKey: string;
  instructions: string;
  promptInput: string;
  signal: AbortSignal;
  debugEvents: boolean;
  watchdogState: {
    lastEvent: string;
    activeTool: string;
    setLastEvent: (eventName: string) => void;
    setActiveTool: (toolName: string) => void;
  };
}): Promise<StreamState> {
  const {
    ctx,
    url,
    model,
    provider,
    conversation,
    gatewaySessionKey,
    instructions,
    promptInput,
    signal,
    debugEvents,
    watchdogState,
  } = input;
  const toolTracker = createToolTracker(debugEvents);
  const state: StreamState = {
    finalText: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    errors: [],
    isError: false,
    lastResponseId: null,
    sessionId: null,
    gatewaySessionKey,
    endpointMode: "responses",
    conversation,
  };

  const response = await openStreamingRequest(
    url,
    {
      model,
      stream: true,
      store: true,
      conversation,
      input: promptInput,
      instructions,
    },
    signal,
  );

  state.sessionId = response.headers.get("X-Hermes-Session-Id");
  state.gatewaySessionKey = response.headers.get("X-Hermes-Session-Key") ?? gatewaySessionKey;

  await emitJsonEvent(ctx, {
    type: HERMES_OBSERVABLE_EVENT_TYPES.init,
    endpointMode: "responses",
    model,
    provider,
    sessionId: state.sessionId,
    gatewaySessionKey: state.gatewaySessionKey,
    conversation,
  });

  const textParts: string[] = [];

  const responseBody = response.body;
  if (!responseBody) {
    throw new HermesAdapterError("Hermes API returned no response body for an SSE request.", {
      code: "hermes_missing_stream_body",
      cliFallbackEligible: true,
      transient: true,
    });
  }

  await consumeSse(responseBody, async (eventName, data) => {
    const effectiveEvent = eventName ?? "message";
    watchdogState.setLastEvent(effectiveEvent);

    if (data === "[DONE]") return;

    const payload = asRecord(safeJsonParse(data));
    if (!payload) {
      if (debugEvents) {
        await emitSystemLine(ctx, `[debug] Non-JSON SSE payload for ${effectiveEvent}: ${truncateText(data, 400)}`);
      }
      return;
    }

    if (effectiveEvent === "response.created") {
      const responsePayload = asRecord(payload.response);
      state.lastResponseId = asString(responsePayload?.id).trim() || state.lastResponseId;
      return;
    }

    if (effectiveEvent === "response.output_text.delta") {
      const delta = asString(payload.delta);
      if (!delta) return;
      textParts.push(delta);
      await emitJsonEvent(ctx, {
        type: HERMES_OBSERVABLE_EVENT_TYPES.textDelta,
        channel: "assistant",
        text: delta,
      });
      return;
    }

    if (effectiveEvent === "response.output_item.added") {
      const item = asRecord(payload.item);
      if (!item) return;
      if (item.type === "function_call") {
        const toolCallId = await toolTracker.resolveRunningId(ctx, {
          toolCallId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
        const toolName = extractToolName(item);
        toolTracker.setActive(toolCallId, toolName);
        watchdogState.setActiveTool(toolName);
        await emitJsonEvent(ctx, {
          type: HERMES_OBSERVABLE_EVENT_TYPES.toolCall,
          name: toolName,
          toolCallId,
          input: extractToolInput(item),
        });
        return;
      }
      if (item.type === "function_call_output") {
        const toolCallId = await toolTracker.resolveCompletedId(ctx, {
          toolCallId: item.call_id,
          name: item.name,
        });
        const toolName = toolTracker.toolName(toolCallId, extractToolName(item));
        await emitJsonEvent(ctx, {
          type: HERMES_OBSERVABLE_EVENT_TYPES.toolResult,
          name: toolName,
          toolCallId,
          content: extractFunctionCallOutput(item),
          isError: item.status === "failed",
        });
        toolTracker.clearActive(toolCallId);
        watchdogState.setActiveTool("none");
        return;
      }
      return;
    }

    if (effectiveEvent === "response.output_item.done") {
      const item = asRecord(payload.item);
      if (!item || item.type !== "function_call") return;
      const toolCallId = await toolTracker.resolveCompletedId(ctx, {
        toolCallId: item.call_id,
        name: item.name,
      });
      const toolName = toolTracker.toolName(toolCallId, extractToolName(item));
      await emitSystemLine(ctx, `tool completed: ${toolName} (${toolCallId})`);
      watchdogState.setActiveTool("none");
      return;
    }

    if (effectiveEvent === "response.completed") {
      const responsePayload = asRecord(payload.response) ?? {};
      const usage = asRecord(responsePayload.usage) ?? {};
      const completedText = extractAssistantTextFromResponse(responsePayload);
      state.lastResponseId = asString(responsePayload.id).trim() || state.lastResponseId;
      state.inputTokens = asNumber(usage.input_tokens, 0);
      state.outputTokens = asNumber(usage.output_tokens, 0);
      state.finalText = completedText || textParts.join("");
      await emitJsonEvent(ctx, {
        type: HERMES_OBSERVABLE_EVENT_TYPES.result,
        text: state.finalText,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cachedTokens: state.cachedTokens,
        costUsd: state.costUsd,
        subtype: "completed",
        isError: false,
        errors: [],
        responseId: state.lastResponseId,
      });
      return;
    }

    if (effectiveEvent === "response.failed" || effectiveEvent === "response.error") {
      const responsePayload = asRecord(payload.response) ?? payload;
      const errorPayload = asRecord(responsePayload.error) ?? responsePayload;
      const message =
        asString(errorPayload.message).trim() ||
        asString(errorPayload.error).trim() ||
        "Hermes response stream failed.";
      state.isError = true;
      state.errors.push(message);
      await emitError(ctx, message);
      return;
    }

    if (debugEvents) {
      await emitSystemLine(ctx, `[debug] Ignored SSE event ${effectiveEvent}: ${truncateText(JSON.stringify(payload), 800)}`);
    }
  });

  if (!state.finalText) {
    state.finalText = textParts.join("");
  }

  return state;
}

async function executeChatCompletionsStream(input: {
  ctx: AdapterExecutionContext;
  url: string;
  model: string;
  provider: string;
  conversation: string;
  sessionId: string | null;
  gatewaySessionKey: string;
  instructions: string;
  promptInput: string;
  signal: AbortSignal;
  debugEvents: boolean;
  watchdogState: {
    lastEvent: string;
    activeTool: string;
    setLastEvent: (eventName: string) => void;
    setActiveTool: (toolName: string) => void;
  };
}): Promise<StreamState> {
  const {
    ctx,
    url,
    model,
    provider,
    conversation,
    sessionId,
    gatewaySessionKey,
    instructions,
    promptInput,
    signal,
    debugEvents,
    watchdogState,
  } = input;
  const toolTracker = createToolTracker(debugEvents);
  const textParts: string[] = [];
  const state: StreamState = {
    finalText: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    errors: [],
    isError: false,
    lastResponseId: null,
    sessionId,
    gatewaySessionKey,
    endpointMode: "chat_completions",
    conversation,
  };

  const headers = buildHeaders();
  if (sessionId) headers["X-Hermes-Session-Id"] = sessionId;
  if (gatewaySessionKey) headers["X-Hermes-Session-Key"] = gatewaySessionKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: promptInput },
        ],
      }),
      signal,
    });
  } catch (error) {
    throw new HermesAdapterError(
      `Could not reach Hermes chat completions API at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: "hermes_api_unreachable",
        cliFallbackEligible: true,
        transient: true,
      },
    );
  }

  if (!response.ok) {
    throw new HermesAdapterError(await readErrorResponse(response), {
      code: "hermes_http_error",
      status: response.status,
      cliFallbackEligible: response.status >= 500,
      transient: response.status >= 500,
    });
  }

  if (!response.body) {
    throw new HermesAdapterError("Hermes API returned no response body for chat completions SSE.", {
      code: "hermes_missing_stream_body",
      cliFallbackEligible: true,
      transient: true,
    });
  }

  state.sessionId = response.headers.get("X-Hermes-Session-Id") ?? state.sessionId;
  state.gatewaySessionKey = response.headers.get("X-Hermes-Session-Key") ?? state.gatewaySessionKey;

  await emitJsonEvent(ctx, {
    type: HERMES_OBSERVABLE_EVENT_TYPES.init,
    endpointMode: "chat_completions",
    model,
    provider,
    sessionId: state.sessionId,
    gatewaySessionKey: state.gatewaySessionKey,
    conversation,
  });

  await consumeSse(response.body, async (eventName, data) => {
    const effectiveEvent = eventName ?? "message";
    watchdogState.setLastEvent(effectiveEvent);

    if (data === "[DONE]") return;

    if (effectiveEvent === "hermes.tool.progress") {
      const payload = asRecord(safeJsonParse(data));
      if (!payload) return;
      const status = asString(payload.status).trim();
      if (status === "running") {
        const toolCallId = await toolTracker.resolveRunningId(ctx, payload);
        const toolName = extractToolName(payload);
        toolTracker.setActive(toolCallId, toolName);
        watchdogState.setActiveTool(toolName);
        await emitJsonEvent(ctx, {
          type: HERMES_OBSERVABLE_EVENT_TYPES.toolCall,
          name: toolName,
          toolCallId,
          input: extractToolInput(payload),
        });
        return;
      }

      if (status === "completed") {
        const toolCallId = await toolTracker.resolveCompletedId(ctx, payload);
        const toolName = toolTracker.toolName(toolCallId, extractToolName(payload));
        await emitSystemLine(ctx, `tool completed: ${toolName} (${toolCallId})`);
        const outputText = extractToolOutput(payload);
        if (outputText.trim().length > 0) {
          await emitJsonEvent(ctx, {
            type: HERMES_OBSERVABLE_EVENT_TYPES.toolResult,
            name: toolName,
            toolCallId,
            content: outputText,
            isError: false,
          });
        }
        toolTracker.clearActive(toolCallId);
        watchdogState.setActiveTool("none");
        return;
      }

      if (debugEvents) {
        await emitSystemLine(ctx, `[debug] Ignored hermes.tool.progress status=${status || "unknown"}: ${truncateText(JSON.stringify(payload), 800)}`);
      }
      return;
    }

    const payload = asRecord(safeJsonParse(data));
    if (!payload) {
      if (debugEvents) {
        await emitSystemLine(ctx, `[debug] Non-JSON chat completions SSE payload: ${truncateText(data, 400)}`);
      }
      return;
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const firstChoice = asRecord(choices[0]) ?? {};
    const delta = asRecord(firstChoice.delta) ?? {};
    const finishReason = asString(firstChoice.finish_reason).trim();

    const contentDelta = asString(delta.content);
    if (contentDelta) {
      textParts.push(contentDelta);
      await emitJsonEvent(ctx, {
        type: HERMES_OBSERVABLE_EVENT_TYPES.textDelta,
        channel: "assistant",
        text: contentDelta,
      });
    }

    const usage = asRecord(payload.usage);
    if (usage) {
      state.inputTokens = asNumber(usage.prompt_tokens, state.inputTokens);
      state.outputTokens = asNumber(usage.completion_tokens, state.outputTokens);
    }

    if (finishReason === "error") {
      state.isError = true;
      const message = "Hermes chat completions stream finished with finish_reason=error.";
      state.errors.push(message);
      await emitError(ctx, message);
    }
  });

  state.finalText = textParts.join("");
  await emitJsonEvent(ctx, {
    type: HERMES_OBSERVABLE_EVENT_TYPES.result,
    text: state.finalText,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cachedTokens: state.cachedTokens,
    costUsd: state.costUsd,
    subtype: state.isError ? "error" : "completed",
    isError: state.isError,
    errors: state.errors,
  });
  return state;
}

function buildResultJson(state: StreamState, model: string, provider: string): Record<string, unknown> {
  return {
    endpointMode: state.endpointMode,
    responseId: state.lastResponseId,
    sessionId: state.sessionId,
    gatewaySessionKey: state.gatewaySessionKey,
    conversation: state.conversation,
    text: state.finalText,
    usage: {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedInputTokens: state.cachedTokens,
    },
    costUsd: state.costUsd,
    provider,
    model,
    errors: state.errors,
  };
}

function shouldFallbackToChat(error: unknown): boolean {
  return error instanceof HermesAdapterError && (error.status === 404 || error.status === 405);
}

function shouldUseCliFallback(error: unknown): boolean {
  return error instanceof HermesAdapterError && error.cliFallbackEligible;
}

function buildCliFallbackConfig(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  if (typeof next.hermesCommand === "string" && next.hermesCommand.trim().length > 0) {
    next.command = next.hermesCommand;
  }
  return next;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(config);
  const debugEvents = asBoolean(config.debugEvents, false);
  const allowCliFallback = asBoolean(config.allowCliFallback, false);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const heartbeatSec = Math.max(1, asNumber(config.heartbeatSec, DEFAULT_HEARTBEAT_SEC));
  const preferredMode = (asString(config.endpointMode).trim() || DEFAULT_ENDPOINT_MODE) as HermesEndpointMode;

  const detectedModel = await detectHermesModel().catch(() => null);
  const model = asString(config.model).trim() || detectedModel?.model || DEFAULT_MODEL;
  const provider = resolveProviderHint({
    explicitProvider: asString(config.provider).trim() || DEFAULT_PROVIDER,
    detectedProvider: detectedModel?.provider,
    detectedModel: detectedModel?.model,
    model,
  });

  const { instructions, input, commandNotes, promptMetrics } = await buildHermesObservablePrompt(ctx, config);
  const sessionParams = asRecord(ctx.runtime.sessionParams) ?? {};
  const conversation = asString(sessionParams.conversation).trim() || buildConversationKey(ctx);
  const gatewaySessionKey =
    asString(sessionParams.gatewaySessionKey).trim() ||
    conversation;
  const sessionId = asString(sessionParams.sessionId).trim() || null;

  if (ctx.executionTarget?.kind === "remote") {
    await emitSystemLine(
      ctx,
      "Remote execution target requested, but Hermes gateway tools execute on the gateway host; continuing on the API-server host.",
    );
  }

  await ctx.onMeta?.({
    adapterType: "hermes_observable",
    command: `POST ${createApiUrl(baseUrl, preferredMode === "chat_completions" ? "/v1/chat/completions" : "/v1/responses")}`,
    cwd: asString(config.cwd).trim() || undefined,
    commandNotes,
    promptMetrics,
    context: {
      endpointMode: preferredMode,
      conversation,
      gatewaySessionKey,
      timeoutSec,
      allowCliFallback,
    },
  });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutSec * 1000);
  maybeTimerUnref(timeoutHandle);

  const startedAt = Date.now();
  let lastEvent = "starting";
  let activeTool = "none";
  const watchdogHandle = setInterval(() => {
    void emitSystemLine(
      ctx,
      `still running: ${Math.round((Date.now() - startedAt) / 1000)}s, lastEvent=${lastEvent}, activeTool=${activeTool}`,
    );
  }, heartbeatSec * 1000);
  maybeTimerUnref(watchdogHandle);

  try {
    await emitSystemLine(
      ctx,
      `starting Hermes observable adapter (mode=${preferredMode}, model=${model}, provider=${provider}, baseUrl=${baseUrl})`,
    );

    const capabilities = await fetchCapabilities(baseUrl, controller.signal).catch((error) => {
      if (allowCliFallback && shouldUseCliFallback(error)) return null;
      throw error;
    });

    let mode: HermesEndpointMode = preferredMode;
    if (preferredMode === "responses" && capabilities && !capabilities.responsesStreaming && capabilities.chatCompletionsStreaming) {
      mode = "chat_completions";
      await emitSystemLine(ctx, "responses streaming unavailable; falling back to chat completions streaming.");
    }

    const watchdogState = {
      lastEvent,
      activeTool,
      setLastEvent(eventName: string) {
        lastEvent = eventName;
      },
      setActiveTool(toolName: string) {
        activeTool = toolName;
      },
    };

    let streamState: StreamState;
    try {
      if (mode === "responses") {
        streamState = await executeResponsesStream({
          ctx,
          url: createApiUrl(baseUrl, "/v1/responses"),
          model,
          provider,
          conversation,
          gatewaySessionKey,
          instructions,
          promptInput: input,
          signal: controller.signal,
          debugEvents,
          watchdogState,
        });
      } else {
        streamState = await executeChatCompletionsStream({
          ctx,
          url: createApiUrl(baseUrl, "/v1/chat/completions"),
          model,
          provider,
          conversation,
          sessionId,
          gatewaySessionKey,
          instructions,
          promptInput: input,
          signal: controller.signal,
          debugEvents,
          watchdogState,
        });
      }
    } catch (error) {
      if (mode === "responses" && shouldFallbackToChat(error)) {
        await emitSystemLine(ctx, "responses endpoint unavailable; retrying with chat completions streaming.");
        streamState = await executeChatCompletionsStream({
          ctx,
          url: createApiUrl(baseUrl, "/v1/chat/completions"),
          model,
          provider,
          conversation,
          sessionId,
          gatewaySessionKey,
          instructions,
          promptInput: input,
          signal: controller.signal,
          debugEvents,
          watchdogState,
        });
      } else {
        throw error;
      }
    }

    activeTool = "none";
    clearTimeout(timeoutHandle);
    clearInterval(watchdogHandle);

    return {
      exitCode: streamState.isError ? 1 : 0,
      signal: null,
      timedOut: false,
      errorMessage: streamState.isError ? streamState.errors.join("\n") : null,
      usage: {
        inputTokens: streamState.inputTokens,
        outputTokens: streamState.outputTokens,
        cachedInputTokens: streamState.cachedTokens,
      } satisfies UsageSummary,
      provider,
      model,
      summary: streamState.finalText || null,
      resultJson: buildResultJson(streamState, model, provider),
      sessionParams: {
        conversation,
        sessionId: streamState.sessionId,
        gatewaySessionKey: streamState.gatewaySessionKey,
        lastResponseId: streamState.lastResponseId,
      },
      sessionDisplayId: conversation,
    };
  } catch (error) {
    clearTimeout(timeoutHandle);
    clearInterval(watchdogHandle);

    if (allowCliFallback && shouldUseCliFallback(error)) {
      await emitSystemLine(
        ctx,
        "gateway API unreachable; falling back to legacy hermes CLI because allowCliFallback=true.",
      );
      return executeHermesCli({
        ...ctx,
        config: buildCliFallbackConfig(config),
      });
    }

    if (controller.signal.aborted) {
      const message = `Hermes API timed out after ${timeoutSec}s.\n${buildSetupHint(baseUrl)}`;
      await emitError(ctx, message);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: message,
        errorCode: "timeout",
        provider,
        model,
        resultJson: {
          endpointMode: preferredMode,
          provider,
          model,
        },
      };
    }

    const message =
      error instanceof HermesAdapterError
        ? `${error.message}\n${buildSetupHint(baseUrl)}`
        : `${error instanceof Error ? error.message : String(error)}\n${buildSetupHint(baseUrl)}`;

    await emitError(ctx, message);

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: error instanceof HermesAdapterError ? error.code : "hermes_observable_error",
      errorFamily:
        error instanceof HermesAdapterError && error.transient
          ? "transient_upstream"
          : null,
      provider,
      model,
      resultJson: {
        endpointMode: preferredMode,
        provider,
        model,
        error: message,
      },
    };
  }
}
