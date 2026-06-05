import type { AdapterExecutionContext, AdapterExecutionResult, UsageSummary } from "../types.js";
import { asNumber, asString, parseObject } from "../utils.js";
import { DEFAULT_FREE_MESH_MODEL, FREE_MESH_DATA_POLICY } from "./constants.js";

type ChatCompletionResponse = {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
};

function readEnv(config: Record<string, unknown>): Record<string, unknown> {
  return parseObject(config.env);
}

function readConfigString(
  config: Record<string, unknown>,
  env: Record<string, unknown>,
  key: string,
  envKey: string,
  fallback = "",
): string {
  const direct = asString(config[key], "");
  if (direct) return direct;
  const envValue = asString(env[envKey], "");
  if (envValue) return envValue;
  return process.env[envKey]?.trim() || fallback;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function buildPrompt(ctx: AdapterExecutionContext, model: string): string {
  const configuredPrompt = asString(ctx.config.promptTemplate, "").trim();
  if (configuredPrompt) return configuredPrompt;

  return [
    "You are a low-stakes Paperclip validation/research agent running through the free-mesh LiteLLM adapter.",
    "Only handle public, non-confidential work. Do not request, infer, expose, or rely on secrets.",
    "You cannot mutate Paperclip directly; return concise findings and next-step recommendations for the operator.",
    "",
    `Agent: ${ctx.agent.name} (${ctx.agent.id})`,
    `Adapter type: ${ctx.agent.adapterType ?? "unknown"}`,
    `Run: ${ctx.runId}`,
    `Model: ${model}`,
    "",
    "Paperclip task context JSON:",
    JSON.stringify(ctx.context, null, 2),
  ].join("\n");
}

function normalizeUsage(usage: ChatCompletionResponse["usage"]): UsageSummary | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  if (inputTokens <= 0 && outputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
  };
}

function readMessage(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config;
  const env = readEnv(config);
  const dataPolicy = asString(config.dataPolicy, "");
  if (dataPolicy !== FREE_MESH_DATA_POLICY) {
    throw new Error(`free-mesh requires dataPolicy="${FREE_MESH_DATA_POLICY}"`);
  }

  const baseUrl = normalizeBaseUrl(readConfigString(config, env, "baseUrl", "FREE_MESH_BASE_URL"));
  if (!baseUrl) throw new Error("free-mesh missing baseUrl or env.FREE_MESH_BASE_URL");
  const apiKey = readConfigString(config, env, "apiKey", "FREE_MESH_API_KEY");
  if (!apiKey) throw new Error("free-mesh missing apiKey or env.FREE_MESH_API_KEY");

  const model = readConfigString(config, env, "model", "FREE_MESH_MODEL", DEFAULT_FREE_MESH_MODEL);
  const temperature = asNumber(config.temperature, 0.2);
  const timeoutMs = asNumber(config.timeoutMs, 60000);
  const prompt = buildPrompt(ctx, model);
  const endpoint = `${baseUrl}/chat/completions`;

  await ctx.onMeta?.({
    adapterType: "free-mesh",
    command: "openai-compatible.chat.completions",
    commandNotes: [
      "Routes through the low-stakes free mesh only.",
      "No Paperclip local agent JWT is exposed to this adapter.",
    ],
    env: {
      FREE_MESH_BASE_URL: baseUrl,
      FREE_MESH_API_KEY: "[redacted]",
    },
    promptMetrics: {
      chars: prompt.length,
    },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          {
            role: "system",
            content:
              "You are a low-stakes public-data validation/research assistant. Never handle secrets, customer data, proprietary code, or high-stakes decisions.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`free-mesh request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = readMessage(payload);
    if (content) await ctx.onLog("stdout", `${content}\n`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "free-mesh",
      biller: "free-mesh",
      billingType: "credits",
      costUsd: 0,
      model: typeof payload.model === "string" && payload.model ? payload.model : model,
      usage: normalizeUsage(payload.usage),
      summary: content ? content.slice(0, 500) : `free-mesh completed with model ${model}`,
      resultJson: {
        responseId: typeof payload.id === "string" ? payload.id : null,
        dataPolicy,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorCode: "timeout",
        errorFamily: "transient_upstream",
        errorMessage: `free-mesh request timed out after ${timeoutMs}ms`,
      };
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
