import type {
  BuilderProvider,
  BuilderProviderConfig,
  BuilderProviderMessage,
  BuilderProviderResponse,
  BuilderProviderToolDef,
} from "../types.js";
import { calculateModelCostCents, hasModelPricing } from "@paperclipai/shared";
import { logger } from "../../../middleware/logger.js";

/**
 * Minimal OpenAI-compatible Chat Completions provider.
 *
 * Works against any endpoint that implements the `POST /chat/completions`
 * surface with function/tool calling — OpenAI, Together, Groq, Ollama
 * (`/v1`), Azure (with `baseUrl` set to the deployment URL), etc.
 *
 * Intentionally tiny: a single non-streaming request per turn. Streaming is
 * planned for Phase 4.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OpenAIChatChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIChatResponse {
  choices?: OpenAIChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function toOpenAIMessage(message: BuilderProviderMessage) {
  if (message.role === "tool") {
    return {
      role: "tool" as const,
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls?.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
    return {
      role: "assistant" as const,
      content: message.content || null,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  return { role: message.role, content: message.content } as const;
}

function safeParseJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function toBuilderFinishReason(value: string | undefined): BuilderProviderResponse["finishReason"] {
  if (value === "stop" || value === "tool_calls" || value === "length") return value;
  return "other";
}

export const openAiCompatProvider: BuilderProvider = {
  type: "openai_compat",
  async chat({ messages, tools, config, signal }): Promise<BuilderProviderResponse> {
    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const url = `${baseUrl}/chat/completions`;

    const body = {
      model: config.model,
      messages: messages.map(toOpenAIMessage),
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parametersSchema,
              },
            })),
            tool_choice: "auto",
          }
        : {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      // Pull a short snippet for diagnostics; do not include the API key.
      const errText = await res.text().catch(() => "");
      throw new Error(
        `OpenAI-compat chat request failed (${res.status}): ${errText.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as OpenAIChatResponse;
    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    const text = typeof message.content === "string" ? message.content : "";
    const toolCalls = (message.tool_calls ?? [])
      .filter((call) => call?.function?.name)
      .map((call, idx) => ({
        id: call.id ?? `call_${idx}`,
        name: call.function!.name!,
        arguments: safeParseJson(call.function?.arguments),
      }));

    return {
      text,
      toolCalls,
      finishReason: toBuilderFinishReason(choice?.finish_reason),
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        costCents: calculateModelCostCents(
          config.model,
          json.usage?.prompt_tokens ?? 0,
          json.usage?.completion_tokens ?? 0,
        ),
      },
    };
  },
};

/**
 * Log a warning if the model lacks pricing data. This is called once per
 * session initialization so operators see the gap in logs without flooding.
 */
export function warnIfMissingPricing(model: string): void {
  if (!hasModelPricing(model)) {
    logger.warn(
      { model },
      "No pricing data for model — budget hard-stop will not trigger for Builder spend",
    );
  }
}

/**
 * Look up a provider implementation by `providerType`. The Builder is single-
 * provider in v0; Anthropic and others land in later phases.
 */
export function getBuilderProvider(providerType: string): BuilderProvider {
  if (providerType === "openai_compat") return openAiCompatProvider;
  throw new Error(`Unsupported builder provider: ${providerType}`);
}

export type { BuilderProvider, BuilderProviderConfig };
