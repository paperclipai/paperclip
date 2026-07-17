import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "../types.js";
import {
  asBoolean,
  asNumber,
  asString,
  parseObject,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function normalizeUrl(config: Record<string, unknown>) {
  const explicitUrl = asString(config.url, "").trim();
  if (explicitUrl) return explicitUrl;

  const baseUrl = asString(config.baseUrl, "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("OpenAI-compatible adapter missing baseUrl or url");
  }
  const endpointPath = asString(config.endpointPath, "/v1/chat/completions").trim() ||
    "/v1/chat/completions";
  return `${baseUrl}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
}

function buildMessages(ctx: AdapterExecutionContext): ChatMessage[] {
  const templateData = {
    agent: ctx.agent,
    runId: ctx.runId,
    context: ctx.context,
  };
  const configuredMessages = Array.isArray(ctx.config.messages) ? ctx.config.messages : [];
  const messages: ChatMessage[] = [];

  for (const item of configuredMessages) {
    const candidate = parseObject(item);
    const role = asString(candidate.role, "");
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    const content = renderTemplate(asString(candidate.content, ""), templateData).trim();
    if (content) messages.push({ role, content });
  }

  if (messages.length > 0) return messages;

  const systemPrompt = renderTemplate(asString(ctx.config.systemPrompt, ""), templateData).trim();
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

  const defaultPrompt = [
    "Run Paperclip heartbeat context for agent {{agent.name}}.",
    "",
    "{{context}}",
  ].join("\n");
  const promptTemplate = asString(ctx.config.promptTemplate, defaultPrompt);
  const userPrompt = renderTemplate(promptTemplate, templateData).trim();
  if (userPrompt) messages.push({ role: "user", content: userPrompt });

  return messages;
}

function buildHeaders(config: Record<string, unknown>) {
  const configuredHeaders = parseObject(config.headers);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const [key, value] of Object.entries(configuredHeaders)) {
    if (typeof value === "string" && key.trim()) headers[key] = value;
  }
  return headers;
}

function asUsage(value: unknown): UsageSummary | undefined {
  const usage = parseObject(value);
  const inputTokens = asNumber(usage.prompt_tokens ?? usage.inputTokens, Number.NaN);
  const outputTokens = asNumber(usage.completion_tokens ?? usage.outputTokens, Number.NaN);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  const cachedInputTokens = asNumber(
    usage.prompt_tokens_details && parseObject(usage.prompt_tokens_details).cached_tokens,
    Number.NaN,
  );
  return {
    inputTokens,
    outputTokens,
    ...(Number.isFinite(cachedInputTokens) ? { cachedInputTokens } : {}),
  };
}

function firstChoiceMessage(responseJson: unknown) {
  const body = parseObject(responseJson);
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = parseObject(choices[0]);
  return {
    body,
    message: parseObject(firstChoice.message),
    finishReason: asString(firstChoice.finish_reason ?? firstChoice.finishReason, ""),
  };
}

function failClosed(input: {
  errorCode: string;
  errorMessage: string;
  resultJson?: Record<string, unknown>;
}): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    resultJson: {
      error: input.errorMessage,
      ...(input.resultJson ?? {}),
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const url = normalizeUrl(ctx.config);
  const model = asString(ctx.config.model, "").trim();
  if (!model) throw new Error("OpenAI-compatible adapter missing model");

  const messages = buildMessages(ctx);
  if (messages.length === 0) throw new Error("OpenAI-compatible adapter produced no messages");

  const timeoutMs = asNumber(
    ctx.config.timeoutMs,
    asNumber(ctx.config.timeoutSec, 30) * 1000,
  );
  const structuredOutput = asBoolean(ctx.config.structuredOutput, false);
  const headers = buildHeaders(ctx.config);
  const responseFormat = structuredOutput ? { type: "json_object" } : parseObject(ctx.config.responseFormat);
  const body: Record<string, unknown> = {
    model,
    messages,
    ...(Object.keys(responseFormat).length > 0 ? { response_format: responseFormat } : {}),
  };

  for (const key of ["temperature", "max_tokens", "max_completion_tokens"]) {
    if (typeof ctx.config[key] === "number") {
      body[key] = ctx.config[key];
    }
  }

  await ctx.onMeta?.({
    adapterType: "openai_compatible",
    command: "openai-compatible-chat-completions",
    commandNotes: [`POST ${new URL(url).origin}${new URL(url).pathname}`],
    context: {
      model,
      messageCount: messages.length,
      structuredOutput,
      timeoutMs,
    },
  });

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!response.ok) {
      return failClosed({
        errorCode: "openai_compatible_http_error",
        errorMessage: `OpenAI-compatible endpoint returned HTTP ${response.status}`,
      });
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      return failClosed({
        errorCode: "openai_compatible_invalid_response",
        errorMessage: "OpenAI-compatible endpoint returned an invalid JSON response.",
      });
    }

    const { body: responseBody, message, finishReason } = firstChoiceMessage(responseJson);
    const content = asString(message.content, "").trim();
    const hasReasoningContent = asString(message.reasoning_content ?? message.reasoningContent, "").trim()
      .length > 0;

    if (hasReasoningContent) {
      await ctx.onLog("stderr", "OpenAI-compatible adapter omitted reasoning_content from captured output.\n");
    }

    if (!content) {
      return failClosed({
        errorCode: "openai_compatible_empty_content",
        errorMessage: "OpenAI-compatible endpoint returned no assistant content.",
        resultJson: { finishReason, hasReasoningContent },
      });
    }

    let parsedStructuredOutput: unknown;
    if (structuredOutput) {
      try {
        parsedStructuredOutput = JSON.parse(content);
      } catch {
        return failClosed({
          errorCode: "openai_compatible_invalid_json",
          errorMessage: "OpenAI-compatible endpoint returned non-JSON assistant content.",
          resultJson: { summary: content, finishReason, hasReasoningContent },
        });
      }
      if (!parsedStructuredOutput || typeof parsedStructuredOutput !== "object" || Array.isArray(parsedStructuredOutput)) {
        return failClosed({
          errorCode: "openai_compatible_invalid_json_shape",
          errorMessage: "OpenAI-compatible endpoint returned JSON that is not an object.",
          resultJson: { summary: content, finishReason, hasReasoningContent },
        });
      }
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "openai_compatible",
      model,
      summary: content,
      usage: asUsage(responseBody.usage),
      usageBasis: "per_run",
      resultJson: {
        summary: content,
        result: content,
        model,
        finishReason,
        hasReasoningContent,
        ...(structuredOutput ? { structuredOutput: parsedStructuredOutput } : {}),
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorCode: "timeout",
        errorMessage: `OpenAI-compatible endpoint timed out after ${timeoutMs}ms`,
        resultJson: {
          error: `OpenAI-compatible endpoint timed out after ${timeoutMs}ms`,
          timeoutMs,
        },
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
