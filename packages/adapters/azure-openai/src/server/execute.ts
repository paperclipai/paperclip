import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_API_VERSION,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_SEC,
  type ApiSurface,
  type DeploymentKind,
  type EndpointMode,
} from "../shared/constants.js";
import { computeCostUsd } from "./pricing.js";
import { resolveAuthHeaders } from "./auth.js";
import {
  buildRequestUrl as buildRequestUrlImpl,
  resolveApiSurface,
} from "./endpoint.js";
import {
  buildResponsesBody,
  extractUsageFromResponses,
  parseResponsesStream,
} from "./responses-api.js";

// ---------------------------------------------------------------------------
// Re-exports the tests + earlier callers rely on
// ---------------------------------------------------------------------------

export { resolveApiSurface } from "./endpoint.js";

/**
 * Back-compat overload for the earlier signature (no endpointMode field). The
 * unit tests in execute.test.ts and the local harness use this shape.
 */
export function buildRequestUrl(args: {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  deploymentKind: DeploymentKind;
  endpointMode?: EndpointMode;
}): string {
  return buildRequestUrlImpl({
    endpoint: args.endpoint,
    deployment: args.deployment,
    apiVersion: args.apiVersion,
    deploymentKind: args.deploymentKind,
    endpointMode: args.endpointMode ?? "deployment",
  });
}

// ---------------------------------------------------------------------------
// Chat Completions request/parse (unchanged from v1)
// ---------------------------------------------------------------------------

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ChatCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

type ChatCompletionStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: ChatCompletionUsage | null;
};

export function buildChatMessages(args: {
  systemPrompt: string | null;
  prompt: string;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (args.systemPrompt && args.systemPrompt.trim().length > 0) {
    messages.push({ role: "system", content: args.systemPrompt.trim() });
  }
  messages.push({ role: "user", content: args.prompt });
  return messages;
}

type ChatParsed = {
  outputText: string;
  finishReason: string | null;
  usage: ChatCompletionUsage | null;
  reportedModel: string | null;
};

export async function parseChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (chunk: string) => Promise<void> | void,
): Promise<ChatParsed> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let output = "";
  let finishReason: string | null = null;
  let usage: ChatCompletionUsage | null = null;
  let reportedModel: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      if (payload === "[DONE]") continue;

      let chunk: ChatCompletionStreamChunk;
      try {
        chunk = JSON.parse(payload) as ChatCompletionStreamChunk;
      } catch {
        continue;
      }

      if (chunk.model && !reportedModel) reportedModel = chunk.model;
      if (chunk.usage) usage = chunk.usage;

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta?.content ?? "";
        if (delta) {
          output += delta;
          await onDelta(delta);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  return { outputText: output, finishReason, usage, reportedModel };
}

function extractChatUsage(u: ChatCompletionUsage | null): UsageSummary | undefined {
  if (!u) return undefined;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  const cachedInputTokens = u.prompt_tokens_details?.cached_tokens;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// Header redaction (auth + operator-supplied extras)
// ---------------------------------------------------------------------------

const SENSITIVE_HEADER_PATTERN =
  /(^|[_-])(auth|authorization|api[_-]?key|token|secret|bearer)([_-]|$)/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_PATTERN.test(k)) {
      out[k] = "***";
      continue;
    }
    // Redact bearer-shaped values even under non-obvious header names
    if (typeof v === "string" && /^Bearer\s+/i.test(v)) {
      out[k] = "Bearer ***";
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runtime, context } = ctx;

  const endpoint = asString(config.endpoint, "");
  if (!endpoint) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `${ADAPTER_TYPE}: missing config.endpoint`,
      errorCode: "config_missing_endpoint",
    };
  }

  const endpointMode: EndpointMode =
    asString(config.endpointMode, "deployment") === "raw" ? "raw" : "deployment";
  const deploymentKind: DeploymentKind =
    asString(config.deploymentKind, "azure_openai") === "azure_ai_foundry"
      ? "azure_ai_foundry"
      : "azure_openai";
  const deployment = asString(config.deployment, "");
  if (
    endpointMode === "deployment" &&
    deploymentKind === "azure_openai" &&
    !deployment
  ) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `${ADAPTER_TYPE}: missing config.deployment (required for deploymentKind='azure_openai' with endpointMode='deployment')`,
      errorCode: "config_missing_deployment",
    };
  }

  const apiVersion = asString(config.apiVersion, DEFAULT_API_VERSION);
  const temperature = asNumber(config.temperature, DEFAULT_TEMPERATURE);
  const maxOutputTokens = asNumber(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const systemPrompt = asString(config.systemPrompt, "");
  const modelHint = asString(config.model, "") || deployment || "";
  const extraHeaders = parseObject(config.headers) as Record<string, string>;

  const apiSurfaceRaw = asString(config.apiSurface, "auto") as ApiSurface;
  const url = buildRequestUrlImpl({
    endpoint,
    deployment,
    apiVersion,
    deploymentKind,
    endpointMode,
  });
  const apiSurface = resolveApiSurface(apiSurfaceRaw, url);

  // Resolve auth (may throw with a helpful message on misconfiguration)
  let authHeaders: Record<string, string>;
  let authDisplayMode: string;
  try {
    const resolved = await resolveAuthHeaders(config);
    authHeaders = resolved.headers;
    authDisplayMode = resolved.displayMode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "config_auth",
    };
  }

  const resumedSession = Boolean(runtime.sessionParams);
  const prompt = renderPaperclipWakePrompt(context, {
    resumedSession,
    includeExecutionContract: true,
  });
  if (!prompt.trim()) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `${ADAPTER_TYPE}: rendered wake prompt was empty`,
      errorCode: "empty_prompt",
    };
  }

  const body =
    apiSurface === "responses"
      ? buildResponsesBody({
          systemPrompt: systemPrompt || null,
          prompt,
          model: modelHint || null,
          temperature,
          maxOutputTokens,
          stream: true,
        })
      : {
          messages: buildChatMessages({ systemPrompt: systemPrompt || null, prompt }),
          temperature,
          max_tokens: maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...authHeaders,
    ...extraHeaders,
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;

  try {
    await ctx.onMeta?.({
      adapterType: ADAPTER_TYPE,
      command: "fetch",
      env: {},
      prompt,
      context: {
        url,
        endpointMode,
        deploymentKind,
        deployment,
        apiVersion,
        apiSurface,
        authMode: authDisplayMode,
        headers: redactHeaders(headers),
      },
    });

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await safeReadText(res);
      const status = res.status;
      const providerQuota = status === 429 && /quota|rate.?limit/i.test(errText);
      const errorFamily =
        providerQuota
          ? ("provider_quota" as const)
          : status === 408 || status === 425 || status === 429 || status >= 500
            ? ("transient_upstream" as const)
            : null;
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `${ADAPTER_TYPE}: HTTP ${status} — ${truncate(errText, 800)}`,
        errorCode: `http_${status}`,
        ...(errorFamily ? { errorFamily } : {}),
        provider: "azure",
        model: modelHint || null,
      };
    }

    let outputText = "";
    let finishReason: string | null = null;
    let reportedModel: string | null = null;
    let usage: UsageSummary | undefined;
    let responseId: string | null = null;

    if (apiSurface === "responses") {
      const parsed = await parseResponsesStream(res.body, async (delta) => {
        await ctx.onLog("stdout", delta);
      });
      outputText = parsed.outputText;
      finishReason = parsed.finishReason;
      reportedModel = parsed.reportedModel;
      usage = extractUsageFromResponses(parsed.usage);
      responseId = parsed.responseId;
      if (parsed.errorMessage) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `${ADAPTER_TYPE}: Responses API stream error — ${parsed.errorMessage}`,
          errorCode: "responses_stream_error",
          provider: "azure",
          model: reportedModel ?? modelHint ?? null,
        };
      }
    } else {
      const parsed = await parseChatCompletionStream(res.body, async (delta) => {
        await ctx.onLog("stdout", delta);
      });
      outputText = parsed.outputText;
      finishReason = parsed.finishReason;
      reportedModel = parsed.reportedModel;
      usage = extractChatUsage(parsed.usage);
    }

    if (outputText.length > 0 && !outputText.endsWith("\n")) {
      await ctx.onLog("stdout", "\n");
    }

    const model = reportedModel ?? modelHint ?? null;
    const costUsd = usage ? computeCostUsd(model, usage) : null;

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "azure",
      model,
      billingType: "metered_api",
      usage,
      usageBasis: "per_run",
      costUsd: costUsd,
      summary: truncate(outputText, 2000),
      resultJson: {
        finish_reason: finishReason,
        duration_ms: Date.now() - startedAt,
        deployment_kind: deploymentKind,
        endpoint_mode: endpointMode,
        api_surface: apiSurface,
        auth_mode: authDisplayMode,
        ...(responseId ? { response_id: responseId } : {}),
      },
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `${ADAPTER_TYPE}: request timed out after ${timeoutSec}s`,
        errorFamily: "transient_upstream",
        provider: "azure",
        model: modelHint || null,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `${ADAPTER_TYPE}: ${message}`,
      errorFamily: "transient_upstream",
      provider: "azure",
      model: modelHint || null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
