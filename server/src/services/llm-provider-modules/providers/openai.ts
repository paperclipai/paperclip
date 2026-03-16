import type { LlmProviderModule } from "../types.js";

export const openaiModule: LlmProviderModule = {
  type: "openai",
  label: "OpenAI GPT",

  async listModels(userApiKey?: string) {
    const apiKey = userApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return [];
    }

    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as any;
      // Filter to only chat models (gpt-*)
      const chatModels = (data.data || []).filter((m: any) => m.id.startsWith("gpt-"));

      return chatModels.map((m: any) => ({
        id: m.id,
        metadata: {
          name: m.id,
          description: m.description || "",
        },
      }));
    } catch {
      return [];
    }
  },

  async validateCredential(apiKey: string) {
    try {
      const response = await fetch("https://api.openai.com/v1/models?limit=1", {
        headers: { Authorization: `Bearer ${apiKey}` },
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

      const data = (await response.json()) as any;
      const modelCount = (data.data || []).filter((m: any) => m.id.startsWith("gpt-")).length;

      return {
        valid: true,
        modelCount: modelCount || 1,
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
