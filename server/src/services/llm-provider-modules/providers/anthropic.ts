import type { LlmProviderModule } from "../types.js";

export const anthropicModule: LlmProviderModule = {
  type: "anthropic",
  label: "Anthropic Claude",

  async listModels(userApiKey?: string) {
    const apiKey = userApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return [];
    }

    // Anthropic doesn't have a public models API, so we return hardcoded list
    const models = [
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200000 },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (2025-05-14)", contextWindow: 200000 },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (2025-10-01)", contextWindow: 200000 },
    ];

    return models.map((m) => ({
      id: m.id,
      metadata: {
        name: m.name,
        contextWindow: m.contextWindow,
      },
    }));
  },

  async validateCredential(apiKey: string) {
    try {
      // Try to make a simple API call to validate the key
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4-1",
          max_tokens: 100,
          messages: [{ role: "user", content: "test" }],
        }),
      });

      if (response.status === 401) {
        return {
          valid: false,
          modelCount: 0,
          error: "Invalid API key",
        };
      }

      if (!response.ok) {
        return {
          valid: false,
          modelCount: 0,
          error: `API error: ${response.status}`,
        };
      }

      return {
        valid: true,
        modelCount: 3,
      };
    } catch (error) {
      return {
        valid: false,
        modelCount: 0,
        error: error instanceof Error ? error.message : "Validation failed",
      };
    }
  },
};
