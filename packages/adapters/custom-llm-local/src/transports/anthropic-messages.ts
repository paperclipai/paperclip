import type { UsageSummary, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { redactSensitive } from "../redact.js";
import {
  classifyFetchError,
  classifyHttpStatus,
  buildErrorResult,
  type CustomLlmError,
} from "../errors.js";
import type { CustomLlmLocalConfig } from "../schema.js";

const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicCallInput {
  config: CustomLlmLocalConfig;
  apiKey: string;
  systemPrompt: string | null;
  userPrompt: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  signal: AbortSignal;
}

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export async function callAnthropicMessages(input: AnthropicCallInput): Promise<AdapterExecutionResult> {
  const { config, apiKey, systemPrompt, userPrompt, onLog, signal } = input;

  const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    ...config.extraHeaders,
  };

  const safeHeaders = redactSensitive(headers);
  await onLog("stdout", `[custom-llm-local] POST ${url} (transport=anthropic_messages, model=${config.model}, headers=${JSON.stringify(safeHeaders)})\n`);

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 8192,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) {
      const e: CustomLlmError = { code: "TIMEOUT", message: `Request timed out after ${config.timeoutSec}s` };
      return buildErrorResult(e);
    }
    return buildErrorResult(classifyFetchError(err));
  }

  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch {
    return buildErrorResult({ code: "BAD_RESPONSE", message: "Failed to read response body" });
  }

  if (!response.ok) {
    return buildErrorResult(classifyHttpStatus(response.status, responseBody));
  }

  let parsed: AnthropicResponse;
  try {
    parsed = JSON.parse(responseBody) as AnthropicResponse;
  } catch {
    return buildErrorResult({ code: "BAD_RESPONSE", message: "Response body is not valid JSON", meta: { body: responseBody.slice(0, 500) } });
  }

  const textBlock = parsed.content?.find((b) => b.type === "text");
  const text = textBlock?.text ?? "";
  if (typeof text !== "string") {
    return buildErrorResult({ code: "BAD_RESPONSE", message: "Unexpected response shape: missing content[0].text", meta: { body: responseBody.slice(0, 500) } });
  }

  const upstreamModel = typeof parsed.model === "string" ? parsed.model : null;
  const resolvedModel = upstreamModel || config.model;

  const usage: UsageSummary | undefined = parsed.usage
    ? {
        inputTokens: parsed.usage.input_tokens ?? 0,
        outputTokens: parsed.usage.output_tokens ?? 0,
      }
    : undefined;

  const finishReason = parsed.stop_reason ?? null;

  const resultJson: Record<string, unknown> = { text, finishReason };
  if (config.modelAlias) resultJson.modelAlias = config.modelAlias;

  await onLog("stdout", `[custom-llm-local] succeeded (model=${resolvedModel}, inputTokens=${usage?.inputTokens ?? "?"},outputTokens=${usage?.outputTokens ?? "?"})\n`);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "custom-llm-local",
    model: resolvedModel,
    usage,
    summary: `anthropic_messages @ ${new URL(url).host} → succeeded`,
    resultJson,
  };
}
