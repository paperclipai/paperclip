import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_BASE_URL = "https://api.kilo.ai/api/gateway";
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TEMPERATURE = 0.7;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return isFinite(n) ? n : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function resolveApiKey(config: Record<string, unknown>): string | null {
  const configKey = asString(config.apiKey, "");
  if (configKey) return configKey;
  const envKey = process.env.KILO_API_KEY?.trim();
  return envKey && envKey.length > 0 ? envKey : null;
}

function mapHttpError(status: number, body: string): { errorMessage: string; errorCode: string } {
  const statusMap: Record<number, string> = {
    400: "kilocode_gateway_bad_request",
    401: "kilocode_gateway_unauthorized",
    402: "kilocode_gateway_payment_required",
    403: "kilocode_gateway_forbidden",
    429: "kilocode_gateway_rate_limited",
    500: "kilocode_gateway_server_error",
    502: "kilocode_gateway_bad_gateway",
    503: "kilocode_gateway_service_unavailable",
  };

  const messageMap: Record<number, string> = {
    400: `KiloCode Gateway: bad request — ${body.slice(0, 200)}`,
    401: "KiloCode Gateway: authentication failed — check your KILO_API_KEY.",
    402: "KiloCode Gateway: payment required — check your KiloCode account balance.",
    403: "KiloCode Gateway: forbidden — the API key may not have permission for this model.",
    429: "KiloCode Gateway: rate limited — too many requests. Retry after a moment.",
    500: `KiloCode Gateway: internal server error — ${body.slice(0, 200)}`,
    502: "KiloCode Gateway: bad gateway — upstream provider may be unavailable.",
    503: "KiloCode Gateway: service unavailable — KiloCode is temporarily down.",
  };

  return {
    errorCode: statusMap[status] ?? "kilocode_gateway_http_error",
    errorMessage: messageMap[status] ?? `KiloCode Gateway: HTTP ${status} — ${body.slice(0, 200)}`,
  };
}

type ParsedDelta = {
  text: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
};

function parseSSELine(line: string): ParsedDelta | null {
  if (!line.startsWith("data: ")) return null;
  const raw = line.slice(6).trim();
  if (raw === "[DONE]") return { text: "", finishReason: "stop", usage: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const firstChoice = choices[0] as Record<string, unknown> | undefined;
  const delta = firstChoice?.delta as Record<string, unknown> | undefined;
  const text = typeof delta?.content === "string" ? delta.content : "";
  const finishReason = typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null;

  let usage: { promptTokens: number; completionTokens: number } | null = null;
  if (typeof obj.usage === "object" && obj.usage !== null) {
    const u = obj.usage as Record<string, unknown>;
    const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
    const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
    if (prompt > 0 || completion > 0) {
      usage = { promptTokens: prompt, completionTokens: completion };
    }
  }

  return { text, finishReason, usage };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const apiKey = resolveApiKey(config);

  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "kilocode_gateway_no_api_key",
      errorMessage:
        "KiloCode Gateway: no API key configured. Set adapterConfig.apiKey or the KILO_API_KEY environment variable.",
    };
  }

  const baseUrl = asString(config.baseUrl, DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = asString(config.model, "");
  const temperature = asNumber(config.temperature, DEFAULT_TEMPERATURE);
  const maxTokens = asNumber(config.maxTokens, DEFAULT_MAX_TOKENS);
  const stream = asBoolean(config.stream, true);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);

  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "kilocode_gateway_no_model",
      errorMessage: "KiloCode Gateway: no model specified. Set adapterConfig.model.",
    };
  }

  const wakePayload = ctx.context.paperclipWake ?? ctx.context;
  const systemPrompt =
    typeof ctx.context.systemPrompt === "string" ? ctx.context.systemPrompt : null;
  const userMessage =
    typeof ctx.context.userMessage === "string"
      ? ctx.context.userMessage
      : JSON.stringify(wakePayload);

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

  const url = `${baseUrl}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      return { exitCode: 1, signal: null, timedOut: true, errorMessage: "KiloCode Gateway: request timed out." };
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "kilocode_gateway_network_error",
      errorMessage: `KiloCode Gateway: network error — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const body = await response.text().catch(() => "");
    const { errorCode, errorMessage } = mapHttpError(response.status, body);
    return { exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage };
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let detectedModel: string | null = null;

  try {
    if (stream && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const delta = parseSSELine(trimmed);
          if (!delta) continue;

          if (delta.text) {
            await ctx.onLog("stdout", delta.text);
          }

          if (delta.usage) {
            promptTokens = delta.usage.promptTokens;
            completionTokens = delta.usage.completionTokens;
          }
        }
      }
    } else {
      const payload = (await response.json()) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const first = choices[0] as Record<string, unknown> | undefined;
      const message = first?.message as Record<string, unknown> | undefined;
      const content = typeof message?.content === "string" ? message.content : "";
      if (content) await ctx.onLog("stdout", content);

      detectedModel =
        typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : null;

      const usage = payload.usage as Record<string, unknown> | undefined;
      if (usage) {
        promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
        completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      return { exitCode: 1, signal: null, timedOut: true, errorMessage: "KiloCode Gateway: streaming timed out." };
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "kilocode_gateway_stream_error",
      errorMessage: `KiloCode Gateway: error reading response — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  clearTimeout(timeout);

  const result: AdapterExecutionResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "kilocode",
    model: detectedModel ?? model,
  };

  if (promptTokens > 0 || completionTokens > 0) {
    result.usage = {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
    };
  }

  return result;
}
