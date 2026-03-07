/**
 * Local Model Client
 *
 * Provides inference via a locally running model server (e.g. Ollama).
 * Used as the final fallback when both Bittensor and Venice AI are unreachable.
 * Cost is always zero (free local compute).
 *
 * Ollama API reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

export interface LocalModelConfig {
  /** Base URL of the local model server – defaults to Ollama's default */
  endpoint?: string;
  /** Model to use – defaults to 'llama3' */
  model?: string;
  /** Request timeout in ms – defaults to 60 000 */
  timeout?: number;
}

export interface LocalModelRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LocalModelResponse {
  success: boolean;
  text?: string;
  model?: string;
  /** Always 0 – local inference has no monetary cost */
  estimatedCostUsd: 0;
  responseTime?: number;
  error?: string;
}

export class LocalModelClient {
  private config: Required<LocalModelConfig>;

  constructor(config: LocalModelConfig = {}) {
    this.config = {
      endpoint: config.endpoint ?? process.env['LOCAL_MODEL_ENDPOINT'] ?? 'http://localhost:11434',
      model: config.model ?? process.env['LOCAL_MODEL_NAME'] ?? 'llama3',
      timeout: config.timeout ?? 60_000,
    };
  }

  /**
   * Send an inference request to the local model server.
   * Uses Ollama's /api/generate endpoint (chat-style prompt).
   */
  async infer(request: LocalModelRequest): Promise<LocalModelResponse> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const fullPrompt = request.systemPrompt
        ? `${request.systemPrompt}\n\n${request.prompt}`
        : request.prompt;

      const body = JSON.stringify({
        model: this.config.model,
        prompt: fullPrompt,
        stream: false,
        options: {
          num_predict: request.maxTokens ?? 2048,
          temperature: request.temperature ?? 0.7,
        },
      });

      const response = await fetch(`${this.config.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        return {
          success: false,
          estimatedCostUsd: 0,
          error: `Local model error ${response.status}: ${errText}`,
        };
      }

      const data = (await response.json()) as { response?: string; model?: string };

      return {
        success: true,
        text: data.response ?? '',
        model: data.model ?? this.config.model,
        estimatedCostUsd: 0,
        responseTime,
      };
    } catch (error) {
      clearTimeout(timer);
      return {
        success: false,
        estimatedCostUsd: 0,
        error: error instanceof Error ? error.message : 'Local model unavailable',
      };
    }
  }

  /**
   * Quick connectivity check – returns true if the local model server responds.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(`${this.config.endpoint}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}
