import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  buildChatEndpoint,
  classifyOllamaFailure,
  classifyOllamaTransportFailure,
  readResponseBody,
  type OllamaApiMode,
} from "./client.js";

type JsonRecord = Record<string, unknown>;
type OllamaToolCall = { id: string; name: string; arguments: JsonRecord };

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readToolCalls(message: JsonRecord): OllamaToolCall[] {
  return asArray(message.tool_calls).flatMap((raw, index) => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    if (!fn) return [];
    const args = typeof fn.arguments === "string" ? parseJsonObject(fn.arguments) : asRecord(fn.arguments);
    return [{
      id: asString(call?.id, `ollama-tool-${index + 1}`),
      name: asString(fn.name, "tool"),
      arguments: args ?? {},
    }];
  });
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readMessage(body: JsonRecord): JsonRecord {
  const choice = asRecord(asArray(body.choices)[0]);
  const openAiMessage = asRecord(choice?.message);
  if (openAiMessage) return openAiMessage;
  return asRecord(body.message) ?? {};
}

function readUsage(body: JsonRecord) {
  const usage = asRecord(body.usage);
  return {
    inputTokens: asNumber(usage?.prompt_tokens ?? usage?.input_tokens, 0),
    outputTokens: asNumber(usage?.completion_tokens ?? usage?.output_tokens, 0),
    cachedInputTokens: asNumber(usage?.prompt_tokens_details && asRecord(usage.prompt_tokens_details)?.cached_tokens, 0),
  };
}

function readPrompt(ctx: AdapterExecutionContext): string {
  const direct = asString(ctx.config.prompt, "").trim();
  if (direct) return direct;
  const taskMarkdown = asString(ctx.context.paperclipTaskMarkdown, "").trim();
  if (taskMarkdown) return taskMarkdown;
  const taskBody = asString(ctx.context.taskBody, "").trim();
  if (taskBody) return taskBody;
  return "Continue the assigned task.";
}

function readToolResults(context: Record<string, unknown>): JsonRecord[] {
  return asArray(context.toolResults).map(asRecord).filter((value): value is JsonRecord => value !== null);
}

function buildToolResultMessages(results: JsonRecord[]): JsonRecord[] {
  return results.flatMap((result) => {
    const toolCallId = asString(result.toolCallId ?? result.tool_call_id ?? result.id, "");
    if (!toolCallId) return [];
    const content = result.content === undefined
      ? JSON.stringify(result.result ?? result.error ?? null)
      : typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    return [{ role: "tool", tool_call_id: toolCallId, content }];
  });
}

function makeSessionParams(baseUrl: string, model: string) {
  return { baseUrl, model };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const baseUrl = asString(ctx.config.baseUrl ?? ctx.config.url, "http://127.0.0.1:11434");
  const apiMode = (asString(ctx.config.apiMode, "openai") || "openai") as OllamaApiMode;
  const model = asString(ctx.config.model, "").trim();
  if (!model) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local requires adapterConfig.model",
      errorCode: "model_refusal",
      errorFamily: "model_refusal",
    };
  }

  const endpoint = buildChatEndpoint(baseUrl, apiMode);
  const timeoutSec = asNumber(ctx.config.timeoutSec, 300);
  const stream = ctx.config.stream !== false;
  const maxToolRounds = Math.max(0, Math.min(8, Math.floor(asNumber(ctx.config.maxToolRounds, 1))));
  const configuredTools = asArray(ctx.config.tools);
  const responseFormat = asRecord(ctx.config.responseFormat ?? ctx.config.structuredOutput);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiKey = asString(ctx.config.apiKey ?? ctx.config.ollamaApiKey, "").trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const messages: JsonRecord[] = [];
  const systemPrompt = asString(ctx.config.systemPrompt, "").trim();
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: readPrompt(ctx) });

  let finalBody: JsonRecord = {};
  let allToolCalls: OllamaToolCall[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const payload: JsonRecord = {
      model,
      messages,
      stream,
      ...(configuredTools.length > 0 ? { tools: configuredTools } : {}),
      ...(responseFormat
        ? apiMode === "ollama"
          ? { format: responseFormat.type === "json_schema" ? responseFormat.json_schema ?? responseFormat : responseFormat.type ?? responseFormat }
          : { response_format: responseFormat }
        : {}),
      ...(ctx.config.options && asRecord(ctx.config.options) ? { options: ctx.config.options } : {}),
    };
    const controller = new AbortController();
    const timer = timeoutSec > 0 ? setTimeout(() => controller.abort(), timeoutSec * 1000) : null;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const failure = classifyOllamaFailure(response.status, detail);
        return {
          exitCode: null,
          signal: null,
          timedOut: failure.errorCode === "timeout",
          errorMessage: failure.message,
          errorCode: failure.errorCode,
          errorFamily: failure.errorFamily,
          model,
          provider: "ollama",
          sessionParams: makeSessionParams(baseUrl, model),
          sessionDisplayId: model,
        };
      }
      finalBody = await readResponseBody(response, {
        stream,
        onDelta: (text) => ctx.onLog("stdout", text),
      });
    } catch (error) {
      const failure = classifyOllamaTransportFailure(error);
      return {
        exitCode: null,
        signal: null,
        timedOut: failure.errorCode === "timeout",
        errorMessage: failure.message,
        errorCode: failure.errorCode,
        errorFamily: failure.errorFamily,
        model,
        provider: "ollama",
        sessionParams: makeSessionParams(baseUrl, model),
        sessionDisplayId: model,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const usage = readUsage(finalBody);
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalCachedInputTokens += usage.cachedInputTokens;
    const message = readMessage(finalBody);
    const toolCalls = readToolCalls(message);
    if (toolCalls.length === 0) break;
    allToolCalls.push(...toolCalls);
    const toolResults = buildToolResultMessages(readToolResults(ctx.context));
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    if (toolResults.length === 0 || round >= maxToolRounds) break;
    messages.push(...toolResults);
  }

  const message = readMessage(finalBody);
  const content = typeof message.content === "string" ? message.content : "";
  const structuredOutput = responseFormat && content ? parseJsonObject(content) : null;
  if (responseFormat && content && !structuredOutput) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: "Ollama returned invalid structured output",
      errorCode: "model_refusal",
      errorFamily: "model_refusal",
      model,
      provider: "ollama",
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: totalCachedInputTokens,
    },
    sessionParams: makeSessionParams(baseUrl, model),
    sessionDisplayId: model,
    provider: "ollama",
    biller: "ollama",
    model,
    billingType: "unknown",
    resultJson: {
      ...(content ? { response: content } : {}),
      ...(structuredOutput ? { structuredOutput } : {}),
      ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
      finishReason: asString(asRecord(asArray(finalBody.choices)[0])?.finish_reason ?? finalBody.done_reason, "stop"),
    },
    summary: content || (allToolCalls.length > 0 ? `Requested ${allToolCalls.length} tool call(s)` : "Ollama completed"),
  };
}
