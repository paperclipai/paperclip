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
  type DeploymentKind,
} from "../shared/constants.js";
import { computeCostUsd } from "./pricing.js";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

type ChatCompletionChoiceDelta = {
  role?: string;
  content?: string | null;
};

type ChatCompletionStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: ChatCompletionChoiceDelta;
    finish_reason?: string | null;
  }>;
  usage?: ChatCompletionUsage | null;
};

/**
 * Build the request URL for Azure OpenAI or Foundry serverless.
 *
 * - Azure OpenAI:      {endpoint}/openai/deployments/{deployment}/chat/completions?api-version={ver}
 * - Foundry serverless:{endpoint}/chat/completions   (deployment/api-version implicit in the endpoint)
 */
export function buildRequestUrl(args: {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  deploymentKind: DeploymentKind;
}): string {
  const base = args.endpoint.replace(/\/+$/, "");
  if (args.deploymentKind === "azure_ai_foundry") {
    // Foundry serverless already carries the model; deployment optional
    return `${base}/chat/completions`;
  }
  const encoded = encodeURIComponent(args.deployment);
  return `${base}/openai/deployments/${encoded}/chat/completions?api-version=${encodeURIComponent(
    args.apiVersion,
  )}`;
}

/**
 * Assemble the chat messages sent to Azure. The Paperclip wake payload is
 * rendered by the shared helper so recovery / task-context / plan-review
 * scaffolding behaves the same as every other adapter.
 */
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

type ParsedSse = {
  outputText: string;
  finishReason: string | null;
  usage: ChatCompletionUsage | null;
  reportedModel: string | null;
};

/**
 * Parse an Azure OpenAI SSE stream body. Each frame is a `data: {json}` line
 * terminated by an empty line; `data: [DONE]` closes the stream. Emits every
 * content delta through the `onDelta` callback so callers can forward chunks
 * to Paperclip's log stream in real time.
 */
export async function parseChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (chunk: string) => Promise<void> | void,
): Promise<ParsedSse> {
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

    // Split on SSE frame boundary (blank line).
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

function extractUsage(u: ChatCompletionUsage | null): UsageSummary | undefined {
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

const SENSITIVE_HEADER_PATTERN = /(^|[_-])(auth|authorization|api[_-]?key|token|secret)([_-]|$)/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_PATTERN.test(k) ? "***" : v;
  }
  return out;
}

/**
 * Adapter execute() entry point.
 */
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

  const apiKey = asString(config.apiKey, "");
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `${ADAPTER_TYPE}: missing config.apiKey`,
      errorCode: "config_missing_api_key",
    };
  }

  const deploymentKind =
    asString(config.deploymentKind, "azure_openai") === "azure_ai_foundry"
      ? "azure_ai_foundry"
      : "azure_openai";
  const deployment = asString(config.deployment, "");
  if (deploymentKind === "azure_openai" && !deployment) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `${ADAPTER_TYPE}: missing config.deployment (required for deploymentKind='azure_openai')`,
      errorCode: "config_missing_deployment",
    };
  }

  const apiVersion = asString(config.apiVersion, DEFAULT_API_VERSION);
  const temperature = asNumber(config.temperature, DEFAULT_TEMPERATURE);
  const maxOutputTokens = asNumber(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const systemPrompt = asString(config.systemPrompt, "");
  const extraHeaders = parseObject(config.headers) as Record<string, string>;

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

  const url = buildRequestUrl({ endpoint, deployment, apiVersion, deploymentKind });
  const messages = buildChatMessages({ systemPrompt: systemPrompt || null, prompt });

  const body = {
    messages,
    temperature,
    max_tokens: maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "api-key": apiKey,
    // Foundry serverless typically also accepts a Bearer token; api-key works for both.
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
        deploymentKind,
        deployment,
        apiVersion,
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
      const providerQuota =
        status === 429 && /quota|rate.?limit/i.test(errText);
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
        model: deployment || null,
      };
    }

    const parsed = await parseChatCompletionStream(res.body, async (delta) => {
      await ctx.onLog("stdout", delta);
    });

    // Trailing newline for shell-style log framing.
    if (parsed.outputText.length > 0 && !parsed.outputText.endsWith("\n")) {
      await ctx.onLog("stdout", "\n");
    }

    const usage = extractUsage(parsed.usage);
    const model = parsed.reportedModel ?? deployment ?? null;
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
      summary: truncate(parsed.outputText, 2000),
      resultJson: {
        finish_reason: parsed.finishReason,
        duration_ms: Date.now() - startedAt,
        deployment_kind: deploymentKind,
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
        model: deployment || null,
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
      model: deployment || null,
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
