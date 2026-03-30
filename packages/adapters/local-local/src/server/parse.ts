// Re-export Claude parse utilities for Claude model runs
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "@paperclipai/adapter-claude-local/server";

import type { UsageSummary } from "@paperclipai/adapter-utils";

// LM Studio response parser (OpenAI-compatible chat completion format)

interface OpenAIChatCompletion {
  id?: string;
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

export function parseLocalLLMResponse(response: OpenAIChatCompletion): {
  summary: string;
  usage: UsageSummary;
  model: string;
} {
  const summary = response.choices?.[0]?.message?.content ?? "";
  const usage: UsageSummary = {
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    cachedInputTokens: 0,
  };
  const model = response.model ?? "unknown";

  return { summary, usage, model };
}
