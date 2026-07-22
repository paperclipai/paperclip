/**
 * OpenAIChatModel — production {@link LlmProvider} adapter.
 *
 * Intentionally dependency-free: it calls the OpenAI REST endpoint with the
 * global fetch (Node 18+). The API key is injected from the environment by the
 * deployment runtime (the CEO's secret store) — this adapter NEVER reads or
 * logs the key, and throws loudly if it is missing.
 *
 * Replace FakeChatModel with `new OpenAIChatModel({ model: "gpt-4o-mini" })`
 * when a real engagement needs production quality. Nothing else in the kit
 * changes.
 */

import type { CompletionRequest, CompletionResponse, LlmProvider } from './types.js';

export interface OpenAIOptions {
  model?: string;
  /** Base URL override (Azure / proxies). Default: OpenAI chat completions. */
  baseUrl?: string;
  /** API key; defaults to process.env.OPENAI_API_KEY. */
  apiKey?: string;
  /** Override fetch (tests / custom transports). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://api.openai.com/v1/chat/completions';

export class OpenAIChatModel implements LlmProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIOptions = {}) {
    this.model = opts.model ?? 'gpt-4o-mini';
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.apiKey) {
      throw new Error(
        'OpenAIChatModel: missing API key. Set OPENAI_API_KEY (from the company secret store) or pass apiKey.',
      );
    }

    const body = {
      model: this.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      tools: req.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: toWireToolChoice(req.toolChoice),
      ...req.extra,
    };

    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as OpenAIResponse;
    const choice = json.choices[0];
    const msg = choice.message;

    return {
      content: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      model: json.model,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
    };
  }
}

function toWireToolChoice(choice: CompletionRequest['toolChoice']): unknown {
  if (!choice || choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  return { type: 'function', function: { name: choice.function.name } };
}

interface OpenAIResponse {
  model: string;
  choices: {
    message: {
      content: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
