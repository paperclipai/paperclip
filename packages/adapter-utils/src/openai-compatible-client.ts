/**
 * OpenAI-compatible API client for Ollama, LM Studio, OpenRouter, and similar platforms.
 * Provides shared HTTP, streaming, retry, and error handling logic.
 */

import { EventEmitter } from "node:events";

export interface OpenAICompatibleClientConfig {
  baseUrl: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  customHeaders?: Record<string, string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message?: ChatMessage;
  delta?: Partial<ChatMessage>;
  finish_reason: string | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  cost?: number;
  [key: string]: unknown;
}

export type ErrorCode =
  | "auth_required"
  | "rate_limit"
  | "transient_upstream"
  | "model_not_found"
  | "context_window_exceeded"
  | "timeout"
  | "validation_error"
  | "connection_error"
  | "unknown";

export interface APIError extends Error {
  code: ErrorCode;
  statusCode?: number;
  retryable: boolean;
  retryNotBefore?: Date;
}

export interface StreamEvent {
  type: "chunk" | "error" | "done";
  data?: Partial<ChatCompletionResponse>;
  error?: APIError;
  usage?: ChatCompletionUsage;
  costUsd?: number;
}

export class OpenAICompatibleClient {
  private config: Required<OpenAICompatibleClientConfig>;
  private requestId: string = "";

  constructor(config: OpenAICompatibleClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      apiKey: config.apiKey || "",
      requestTimeoutMs: config.requestTimeoutMs || 120000,
      maxRetries: config.maxRetries || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      customHeaders: config.customHeaders || {},
    };
  }

  /**
   * Create a chat completion with automatic streaming support.
   * Yields events for each chunk, errors, and completion.
   */
  async *streamChatCompletion(
    request: ChatCompletionRequest,
    options?: { requestId?: string }
  ): AsyncGenerator<StreamEvent> {
    this.requestId = options?.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const payload = {
      ...request,
      stream: true,
    };

    let attempt = 0;
    let lastError: APIError | null = null;

    while (attempt < this.config.maxRetries) {
      try {
        yield* this.performStreamRequest(payload);
        return;
      } catch (err) {
        lastError = this.classifyError(err);

        if (!lastError.retryable || attempt >= this.config.maxRetries - 1) {
          yield {
            type: "error",
            error: lastError,
          };
          return;
        }

        const delayMs = this.config.retryDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt++;
      }
    }

    if (lastError) {
      yield {
        type: "error",
        error: lastError,
      };
    }
  }

  private async *performStreamRequest(
    payload: ChatCompletionRequest
  ): AsyncGenerator<StreamEvent> {
    const headers = this.buildHeaders();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }

      if (!response.body) {
        throw new Error("Response body is empty");
      }

      yield* this.parseStreamResponse(response.body, response.headers);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async *parseStreamResponse(
    body: ReadableStream<Uint8Array>,
    responseHeaders: Headers
  ): AsyncGenerator<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "[DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            try {
              const data = JSON.parse(jsonStr) as ChatCompletionResponse;

              if (data.choices?.[0]) {
                const choice = data.choices[0];
                const delta = choice.delta || choice.message;

                if (delta) {
                  yield {
                    type: "chunk",
                    data: {
                      id: data.id,
                      model: data.model,
                      choices: [
                        {
                          index: choice.index || 0,
                          delta,
                          finish_reason: choice.finish_reason,
                        },
                      ],
                    },
                  };
                }

                if (choice.finish_reason && data.usage) {
                  totalInputTokens = data.usage.prompt_tokens || 0;
                  totalOutputTokens = data.usage.completion_tokens || 0;
                }
              }
            } catch (err) {
              // Skip malformed JSON lines
            }
          }
        }
      }

      // Parse final usage from response headers if available
      const usage = this.parseUsageFromHeaders(responseHeaders);
      const costUsd = this.parseCostFromHeaders(responseHeaders);

      yield {
        type: "done",
        usage: usage || {
          prompt_tokens: totalInputTokens,
          completion_tokens: totalOutputTokens,
          total_tokens: totalInputTokens + totalOutputTokens,
        },
        costUsd,
      };
    } finally {
      reader.releaseLock();
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "paperclip-adapter/1.0",
      "X-Request-ID": this.requestId,
      ...this.config.customHeaders,
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  private async parseErrorResponse(response: Response): Promise<APIError> {
    let errorDetails: Record<string, unknown> = {};

    try {
      errorDetails = await response.json();
    } catch {
      // Ignore JSON parse errors
    }

    const statusCode = response.status;
    const message =
      (errorDetails.error as Record<string, unknown> | undefined)?.message ||
      errorDetails.message ||
      `HTTP ${statusCode}`;

    const error = new Error(String(message)) as APIError;
    error.statusCode = statusCode;
    error.code = this.classifyHttpError(statusCode, message as string);
    error.retryable = statusCode >= 500 || statusCode === 429;

    if (statusCode === 429) {
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const delaySeconds = parseInt(retryAfter, 10);
        error.retryNotBefore = new Date(Date.now() + delaySeconds * 1000);
      }
    }

    return error;
  }

  private classifyError(err: unknown): APIError {
    if (err instanceof Error && "code" in err && "retryable" in err) {
      return err as APIError;
    }

    if (err instanceof TypeError && err.message.includes("fetch")) {
      const apiError = new Error(err.message) as APIError;
      apiError.code = "connection_error";
      apiError.retryable = true;
      return apiError;
    }

    if (err instanceof Error && err.name === "AbortError") {
      const apiError = new Error("Request timeout") as APIError;
      apiError.code = "timeout";
      apiError.retryable = true;
      return apiError;
    }

    const apiError = new Error(err instanceof Error ? err.message : String(err)) as APIError;
    apiError.code = "unknown";
    apiError.retryable = false;
    return apiError;
  }

  private classifyHttpError(statusCode: number, message: string): ErrorCode {
    if (statusCode === 401 || statusCode === 403) {
      return "auth_required";
    }
    if (statusCode === 429) {
      return "rate_limit";
    }
    if (statusCode === 404 && message.toLowerCase().includes("model")) {
      return "model_not_found";
    }
    if (statusCode === 400 && message.toLowerCase().includes("context")) {
      return "context_window_exceeded";
    }
    if (statusCode === 408 || statusCode === 504) {
      return "timeout";
    }
    if (statusCode >= 500) {
      return "transient_upstream";
    }
    if (statusCode === 400 || statusCode === 422) {
      return "validation_error";
    }
    return "unknown";
  }

  private parseUsageFromHeaders(headers: Headers): ChatCompletionUsage | null {
    // Some platforms return usage in headers
    const promptTokens = headers.get("x-prompt-tokens");
    const completionTokens = headers.get("x-completion-tokens");

    if (promptTokens && completionTokens) {
      return {
        prompt_tokens: parseInt(promptTokens, 10),
        completion_tokens: parseInt(completionTokens, 10),
        total_tokens: parseInt(promptTokens, 10) + parseInt(completionTokens, 10),
      };
    }

    return null;
  }

  private parseCostFromHeaders(headers: Headers): number | undefined {
    const costHeader = headers.get("x-cost");
    if (costHeader) {
      const cost = parseFloat(costHeader);
      return isNaN(cost) ? undefined : cost;
    }
    return undefined;
  }

  /**
   * Test connectivity and authentication.
   */
  async testConnection(): Promise<void> {
    const headers = this.buildHeaders();

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/models`, {
        method: "GET",
        headers,
        timeout: 5000,
      });

      if (!response.ok) {
        throw await this.parseErrorResponse(response);
      }
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  /**
   * Fetch available models from the provider.
   */
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    const headers = this.buildHeaders();

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/models`, {
        method: "GET",
        headers,
        timeout: 10000,
      });

      if (!response.ok) {
        throw await this.parseErrorResponse(response);
      }

      const data = (await response.json()) as {
        data?: Array<{ id: string; name?: string }>;
      };
      return (data.data || []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
      }));
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  /**
   * Extract quota/rate limit information from headers.
   */
  parseQuotaHeaders(headers: Headers): {
    remaining?: number;
    limit?: number;
    resetAt?: Date;
  } {
    const remaining = headers.get("x-ratelimit-remaining-requests");
    const limit = headers.get("x-ratelimit-limit-requests");
    const resetAt = headers.get("x-ratelimit-reset-requests");

    return {
      remaining: remaining ? parseInt(remaining, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      resetAt: resetAt ? new Date(parseInt(resetAt, 10) * 1000) : undefined,
    };
  }
}

/**
 * Helper to aggregate streaming chunks into a full response.
 */
export async function aggregateStream(
  stream: AsyncGenerator<StreamEvent>
): Promise<{
  content: string;
  usage: ChatCompletionUsage;
  costUsd?: number;
  error?: APIError;
}> {
  let content = "";
  let usage: ChatCompletionUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let costUsd: number | undefined;
  let error: APIError | undefined;

  for await (const event of stream) {
    if (event.type === "chunk" && event.data?.choices?.[0]?.delta?.content) {
      content += event.data.choices[0].delta.content;
    } else if (event.type === "done" && event.usage) {
      usage = event.usage;
      costUsd = event.costUsd;
    } else if (event.type === "error" && event.error) {
      error = event.error;
    }
  }

  if (error) {
    throw error;
  }

  return { content, usage, costUsd };
}
