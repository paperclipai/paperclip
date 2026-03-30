import type { UsageSummary } from "@paperclipai/adapter-utils";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

export interface LMStudioResult {
  summary: string;
  model: string;
  usage: UsageSummary;
  finishReason: string | null;
}

interface ChatCompletionChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string | null;
}

interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

interface LMStudioModel {
  id: string;
  object: string;
  owned_by?: string;
}

interface LMStudioModelsResponse {
  data: LMStudioModel[];
}

export function resolveBaseUrl(configBaseUrl: unknown): string {
  if (typeof configBaseUrl === "string" && configBaseUrl.trim().length > 0) {
    return configBaseUrl.trim().replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function executeLocalModel(opts: {
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<LMStudioResult> {
  const url = `${opts.baseUrl}/chat/completions`;

  await opts.onLog("stdout", `[paperclip] LM Studio: POST ${url} model=${opts.model}\n`);

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: opts.prompt }],
        stream: false,
        temperature: 0.1,
      }),
    },
    opts.timeoutMs,
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `LM Studio returned ${response.status}: ${errorBody || response.statusText}`,
    );
  }

  const body = (await response.json()) as ChatCompletionResponse;

  const content = body.choices?.[0]?.message?.content ?? "";
  const finishReason = body.choices?.[0]?.finish_reason ?? null;
  const usage: UsageSummary = {
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    cachedInputTokens: 0,
  };

  await opts.onLog("stdout", `[paperclip] LM Studio: completed (${usage.inputTokens} in / ${usage.outputTokens} out)\n`);

  return {
    summary: content,
    model: body.model || opts.model,
    usage,
    finishReason,
  };
}

export async function testLMStudioAvailability(baseUrl: string): Promise<{
  available: boolean;
  models: string[];
  error: string | null;
}> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/models`,
      { method: "GET" },
      5000,
    );

    if (!response.ok) {
      return {
        available: false,
        models: [],
        error: `LM Studio returned ${response.status}`,
      };
    }

    const body = (await response.json()) as LMStudioModelsResponse;
    const modelIds = (body.data ?? []).map((m) => m.id);

    return {
      available: true,
      models: modelIds,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      models: [],
      error: message.includes("ECONNREFUSED")
        ? `LM Studio is not running at ${baseUrl}`
        : `LM Studio check failed: ${message}`,
    };
  }
}

export async function listLMStudioModels(baseUrl: string): Promise<Array<{ id: string; label: string }>> {
  const result = await testLMStudioAvailability(baseUrl);
  if (!result.available) return [];
  return result.models.map((id) => ({ id, label: `${id} (Local)` }));
}
