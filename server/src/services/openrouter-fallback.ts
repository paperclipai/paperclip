/**
 * OpenRouter Free Model Fallback
 *
 * When an adapter execution fails, this service retries the task
 * using free models on OpenRouter (xiaomi/mimo-v2-pro, stepfun/step-3.5-flash:free).
 */
import { logger } from "../middleware/logger.js";

export interface FallbackConfig {
  enabled: boolean;
  models: string[];
  provider: string;
  maxRetries: number;
}

export interface FallbackResult {
  success: boolean;
  model: string;
  response: string | null;
  error: string | null;
  tokensUsed: { input: number; output: number } | null;
}

export async function executeFallback(opts: {
  config: FallbackConfig;
  prompt: string;
  systemPrompt?: string;
  apiKey: string;
}): Promise<FallbackResult> {
  for (const model of opts.config.models) {
    try {
      logger.info({ model }, "Attempting OpenRouter fallback");
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://paperclip.evohaus.org",
          "X-Title": "Paperclip Agent Fallback",
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(opts.systemPrompt ? [{ role: "system" as const, content: opts.systemPrompt }] : []),
            { role: "user" as const, content: opts.prompt },
          ],
          max_tokens: 4096,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        logger.warn({ model, status: response.status, error: errorText }, "OpenRouter fallback model failed, trying next");
        continue;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? null;
      const usage = data.usage;

      return {
        success: true,
        model,
        response: content,
        error: null,
        tokensUsed: usage ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 } : null,
      };
    } catch (err) {
      logger.warn({ model, err }, "OpenRouter fallback fetch error, trying next model");
      continue;
    }
  }

  return {
    success: false,
    model: opts.config.models[opts.config.models.length - 1] ?? "unknown",
    response: null,
    error: "All fallback models failed",
    tokensUsed: null,
  };
}

export function parseFallbackConfig(runtimeConfig: unknown): FallbackConfig | null {
  if (typeof runtimeConfig !== "object" || runtimeConfig === null) return null;
  const rc = runtimeConfig as Record<string, unknown>;
  const fb = rc.fallback as Record<string, unknown> | undefined;
  if (!fb || fb.enabled !== true) return null;
  const models = fb.models;
  if (!Array.isArray(models) || models.length === 0) return null;
  return {
    enabled: true,
    models: models.filter((m): m is string => typeof m === "string"),
    provider: (fb.provider as string) ?? "openrouter",
    maxRetries: (fb.maxRetries as number) ?? 2,
  };
}

export function buildFallbackPrompt(
  context: Record<string, unknown>,
  agent: { name: string; role: string },
): string {
  const issueTitle = (context.issueTitle ?? context.paperclipIssueTitle ?? "") as string;
  const issueDesc = (context.issueDescription ?? context.paperclipIssueDescription ?? "") as string;
  const wakeReason = (context.wakeReason ?? context.paperclipWakeReason ?? "") as string;

  return [
    `# Task for ${agent.name} (${agent.role})`,
    issueTitle ? `## Issue: ${issueTitle}` : "",
    issueDesc ? `${issueDesc}` : "",
    wakeReason ? `## Wake Reason: ${wakeReason}` : "",
    "",
    "Complete this task concisely. If you cannot complete it, explain what's blocking you.",
  ].filter(Boolean).join("\n");
}
