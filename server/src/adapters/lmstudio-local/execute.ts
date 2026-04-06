import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, parseObject } from "../utils.js";

/**
 * Executes an agent run against an LM Studio local server using its
 * OpenAI-compatible chat completions endpoint.
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const rawConfig = parseObject(config);

  const apiBaseUrl = asString(rawConfig.apiBaseUrl, "http://localhost:1234/v1");
  const apiKey = asString(rawConfig.apiKey, "lm-studio");
  const model = asString(rawConfig.model, "");

  const chatUrl = `${apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;

  const systemPrompt = context.prompt ?? context.task ?? "You are a helpful assistant.";
  const userMessage = context.task ?? context.prompt ?? "";

  const controller = new AbortController();
  const timeoutMs = 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || undefined,
        messages: [
          { role: "system", content: systemPrompt },
          ...(userMessage ? [{ role: "user", content: userMessage }] : []),
        ],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`LM Studio API error (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const reply = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage;

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: reply.slice(0, 500),
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        summary: "LM Studio request timed out",
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
