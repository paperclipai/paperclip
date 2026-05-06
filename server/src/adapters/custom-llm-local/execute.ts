import fs from "node:fs/promises";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, joinPromptSections, renderPaperclipWakePrompt, renderTemplate } from "@paperclipai/adapter-utils/server-utils";
import { asString, parseObject } from "../utils.js";
import {
  parseCustomLlmLocalConfig,
  type CustomLlmLocalConfig,
} from "./config.js";

type TransportRequest = {
  config: CustomLlmLocalConfig;
  apiKey: string | null;
  systemPrompt: string | null;
  userPrompt: string;
  signal: AbortSignal;
};

type TransportResponse = {
  text: string;
  finishReason: string | null;
  usage: { inputTokens?: number; outputTokens?: number };
  raw: Record<string, unknown>;
};

const REDACTED_HEADER_PATTERN = /(authorization|api[-_]?key|token|secret|cookie)/i;

function redactHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, REDACTED_HEADER_PATTERN.test(key) ? "<redacted>" : value]),
  );
}

async function readInstructionsFile(pathValue: string | null): Promise<string | null> {
  if (!pathValue) return null;
  const content = await fs.readFile(pathValue, "utf8");
  return content.trim().length > 0 ? content.trim() : null;
}

function toUsageSummary(usage: TransportResponse["usage"]): AdapterExecutionResult["usage"] | undefined {
  const hasInput = typeof usage.inputTokens === "number";
  const hasOutput = typeof usage.outputTokens === "number";
  if (!hasInput && !hasOutput) return undefined;
  return {
    inputTokens: hasInput ? usage.inputTokens! : 0,
    outputTokens: hasOutput ? usage.outputTokens! : 0,
  };
}

function buildPrompt(ctx: AdapterExecutionContext, template: string | null) {
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const renderedTemplate = renderTemplate(
    template || DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
    {
      agent: ctx.agent,
      agentId: ctx.agent.id,
      companyId: ctx.agent.companyId,
      context: ctx.context,
      contextJson: JSON.stringify(ctx.context, null, 2),
      run: { id: ctx.runId },
      runId: ctx.runId,
    },
  ).trim();

  return joinPromptSections([wakePrompt, renderedTemplate]);
}

function normalizeTransportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CONFIG_INVALID:")) return message;
  if (message === "AbortError" || message.includes("aborted")) {
    return "TIMEOUT: upstream request timed out";
  }
  if (message.toLowerCase().includes("fetch failed")) {
    return `CONNECTION_FAILED: ${message}`;
  }
  return `UPSTREAM_REQUEST_FAILED: ${message}`;
}

function parseOpenAiText(payload: Record<string, unknown>): TransportResponse {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = parseObject(choices[0]);
  const message = parseObject(firstChoice.message);
  const content = asString(message.content, "");
  if (!content) {
    throw new Error("UPSTREAM_RESPONSE_INVALID: OpenAI transport response did not include assistant content");
  }
  const usage = parseObject(payload.usage);
  return {
    text: content,
    finishReason: asString(firstChoice.finish_reason, "") || null,
    usage: {
      inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
      outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    },
    raw: payload,
  };
}

function parseAnthropicText(payload: Record<string, unknown>): TransportResponse {
  const contentItems = Array.isArray(payload.content) ? payload.content : [];
  const text = contentItems
    .map((entry) => parseObject(entry))
    .filter((entry) => asString(entry.type, "") === "text")
    .map((entry) => asString(entry.text, ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("UPSTREAM_RESPONSE_INVALID: Anthropic transport response did not include text content");
  }
  const usage = parseObject(payload.usage);
  return {
    text,
    finishReason: asString(payload.stop_reason, "") || null,
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    },
    raw: payload,
  };
}

async function runTransport(request: TransportRequest): Promise<TransportResponse> {
  const { config, apiKey, systemPrompt, userPrompt, signal } = request;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...config.extraHeaders,
  };

  let url = "";
  let body: Record<string, unknown> = {};

  if (config.transport === "openai_chat_completions") {
    url = `${config.baseUrl}/chat/completions`;
    if (apiKey && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    body = {
      model: config.model,
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        { role: "user", content: userPrompt },
      ],
      stream: false,
    };
  } else {
    url = `${config.baseUrl}/messages`;
    if (apiKey && !headers["x-api-key"]) {
      headers["x-api-key"] = apiKey;
    }
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }
    body = {
      model: config.model,
      max_tokens: 8192,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: "user", content: userPrompt }],
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const detail = bodyText.trim().slice(0, 400);
    throw new Error(
      `UPSTREAM_HTTP_${response.status}: ${detail || response.statusText || "request failed"}`,
    );
  }

  const json = parseObject(await response.json());
  return config.transport === "openai_chat_completions"
    ? parseOpenAiText(json)
    : parseAnthropicText(json);
}

export async function executeCustomLlmLocal(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  let config: CustomLlmLocalConfig;
  try {
    config = parseCustomLlmLocalConfig(ctx.config);
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "CONFIG_INVALID",
      errorMessage: error instanceof Error ? error.message : "Invalid adapter configuration",
      summary: error instanceof Error ? error.message : "Invalid adapter configuration",
      provider: "custom-llm-local",
      biller: "custom-llm-local",
    };
  }

  const apiKey = config.apiKeyEnv ? (process.env[config.apiKeyEnv] ?? null) : null;
  let instructions: string | null;
  try {
    instructions = await readInstructionsFile(config.instructionsFilePath);
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "CONFIG_INVALID",
      errorMessage: `CONFIG_INVALID: unable to read instructionsFilePath (${String(error)})`,
      summary: `CONFIG_INVALID: unable to read instructionsFilePath (${String(error)})`,
      provider: "custom-llm-local",
      biller: "custom-llm-local",
    };
  }

  const prompt = buildPrompt(ctx, config.promptTemplate);
  const controller = new AbortController();
  const timeoutMs = Math.max(1, config.timeoutSec) * 1000;
  const graceMs = Math.max(0, config.graceSec) * 1000;
  let graceTimer: NodeJS.Timeout | null = null;
  const timeoutTimer = setTimeout(() => {
    graceTimer = setTimeout(() => controller.abort(), graceMs);
  }, timeoutMs);

  const mergedHeaders = redactHeaders({
    ...(config.apiKeyEnv && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...config.extraHeaders,
  });

  await ctx.onMeta?.({
    adapterType: "custom_llm_local",
    command: `POST ${config.baseUrl}`,
    prompt,
    commandNotes: [
      `transport=${config.transport}`,
      `model=${config.model}`,
      ...(config.modelAlias ? [`modelAlias=${config.modelAlias}`] : []),
      ...(config.apiKeyEnv ? [`apiKeyEnv=${config.apiKeyEnv}`] : []),
      ...(config.instructionsFilePath ? [`instructionsFilePath=${config.instructionsFilePath}`] : []),
      `headers=${JSON.stringify(mergedHeaders)}`,
    ],
    promptMetrics: { lengthChars: prompt.length },
  });

  try {
    const result = await runTransport({
      config,
      apiKey,
      systemPrompt: instructions,
      userPrompt: prompt,
      signal: controller.signal,
    });

    clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: result.text.trim(),
      provider: "custom-llm-local",
      biller: "custom-llm-local",
      usage: toUsageSummary(result.usage),
      resultJson: {
        ...result.raw,
        transport: config.transport,
        modelAlias: config.modelAlias,
      },
    };
  } catch (error) {
    clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    const normalized = normalizeTransportError(error);
    const [code, ...rest] = normalized.split(": ");
    return {
      exitCode: code === "TIMEOUT" ? null : 1,
      signal: null,
      timedOut: code === "TIMEOUT",
      errorCode: code || "UPSTREAM_REQUEST_FAILED",
      errorMessage: rest.join(": ") || normalized,
      summary: rest.join(": ") || normalized,
      provider: "custom-llm-local",
      biller: "custom-llm-local",
    };
  }
}
