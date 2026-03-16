import type { LlmProviderModule } from "../types.js";

export const openrouterModule: LlmProviderModule = {
  type: "openrouter",
  label: "OpenRouter",

  async listModels(userApiKey?: string) {
    const apiKey = userApiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return [];
    }

    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as any;
      return (data.data || []).map((m: any) => ({
        id: m.id,
        metadata: {
          name: m.name,
          contextWindow: m.context_length,
          pricingPer1mInput: m.pricing?.prompt,
          pricingPer1mOutput: m.pricing?.completion,
          description: m.description,
        },
      }));
    } catch {
      return [];
    }
  },

  async validateCredential(apiKey: string) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models?limit=1", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        return {
          valid: false,
          modelCount: 0,
          error: "Invalid API key or network error",
        };
      }

      const data = (await response.json()) as any;
      const modelCount = (data.data || []).length;

      return {
        valid: true,
        modelCount,
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
