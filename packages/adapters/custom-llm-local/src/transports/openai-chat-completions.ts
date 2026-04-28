import type { UsageSummary, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { redactSensitive } from "../redact.js";
import {
  classifyFetchError,
  classifyHttpStatus,
  buildErrorResult,
  type CustomLlmError,
} from "../errors.js";
import type { CustomLlmLocalConfig } from "../schema.js";

export interface OAICallInput {
  config: CustomLlmLocalConfig;
  apiKey: string;
  systemPrompt: string | null;
  userPrompt: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  signal: AbortSignal;
}

interface OAIResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function callOpenAiChatCompletions(input: OAICallInput): Promise<AdapterExecutionResult> {
  const { config, apiKey, systemPrompt, userPrompt, onLog, signal } = input;

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userPrompt });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.extraHeaders,
  };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const safeHeaders = redactSensitive(headers);
  await onLog("stdout", `[custom-llm-local] POST ${url} (transport=openai_chat_completions, model=${config.model}, headers=${JSON.stringify(safeHeaders)})\n`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages,
      }),
      signal,
    });
  } catch (err) {
    // Check if it was an abort (timeout)
    if (signal.aborted) {
      const e: CustomLlmError = { code: "TIMEOUT", message: `Request timed out after ${config.timeoutSec}s` };
      return buildErrorResult(e);
    }
    return buildErrorResult(classifyFetchError(err));
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return buildErrorResult({ code: "BAD_RESPONSE", message: "Failed to read response body" });
  }

  if (!response.ok) {
    return buildErrorResult(classifyHttpStatus(response.status, body));
  }

  let parsed: OAIResponse;
  try {
    parsed = JSON.parse(body) as OAIResponse;
  } catch {
    return buildErrorResult({ code: "BAD_RESPONSE", message: "Response body is not valid JSON", meta: { body: body.slice(0, 500) } });
  }

  const text = parsed.choices?.[0]?.message?.content ?? "";
  if (typeof text !== "string") {
    return buildErrorResult({ code: "BAD_RESPONSE", message: "Unexpected response shape: missing choices[0].message.content", meta: { body: body.slice(0, 500) } });
  }

  const upstreamModel = typeof parsed.model === "string" ? parsed.model : null;
  const resolvedModel = upstreamModel || config.model;

  const usage: UsageSummary | undefined = parsed.usage
    ? {
        inputTokens: parsed.usage.prompt_tokens ?? 0,
        outputTokens: parsed.usage.completion_tokens ?? 0,
      }
    : undefined;

  const finishReason = parsed.choices?.[0]?.finish_reason ?? null;

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
    summary: `openai_chat_completions @ ${new URL(url).host} → succeeded`,
    resultJson,
  };
}
