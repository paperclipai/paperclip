export type LlmProviderType = "openrouter" | "anthropic" | "openai" | "huggingface" | "ollama" | "custom";

export interface LlmModel {
  id: string;
  name: string;
  provider: LlmProviderType;
  contextWindow?: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
  description?: string;
  archived?: boolean;
}

export interface LlmValidationResult {
  valid: boolean;
  modelCount: number;
  error?: string;
}

export interface LlmProviderModule {
  type: LlmProviderType;
  label: string;

  /**
   * List available models for this provider.
   * If userApiKey is provided, use it; otherwise use platform defaults.
   */
  listModels(userApiKey?: string, baseUrl?: string): Promise<Array<{ id: string; metadata: Record<string, unknown> }>>;

  /**
   * Validate a credential (API key) and return the model count.
   */
  validateCredential(apiKey: string, baseUrl?: string): Promise<LlmValidationResult>;

  /**
   * Execute an LLM call.
   * Not used in Phase 1, but defined for future use.
   */
  call?(params: {
    apiKey: string;
    modelId: string;
    baseUrl?: string;
    prompt: string;
    system?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string>;
}
