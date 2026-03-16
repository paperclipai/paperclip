import type { LlmProviderModule } from "../types.js";

export const customModule: LlmProviderModule = {
  type: "custom",
  label: "Custom LLM Provider",

  async listModels(userApiKey?: string, baseUrl?: string) {
    if (!baseUrl) {
      return [];
    }

    try {
      // Assume custom provider has a /models endpoint
      const response = await fetch(`${baseUrl}/models`, {
        headers: userApiKey ? { Authorization: `Bearer ${userApiKey}` } : {},
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as any;
      const models = Array.isArray(data) ? data : data.data || data.models || [];

      return models.map((m: any) => ({
        id: typeof m === "string" ? m : m.id || m.name,
        metadata: {
          name: typeof m === "string" ? m : m.name || m.id,
          ...(typeof m === "object" ? m : {}),
        },
      }));
    } catch {
      return [];
    }
  },

  async validateCredential(apiKey: string, baseUrl?: string) {
    if (!baseUrl) {
      return {
        valid: false,
        modelCount: 0,
        error: "Base URL is required for custom providers",
      };
    }

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });

      if (response.status === 401) {
        return {
          valid: false,
          modelCount: 0,
          error: "Authentication failed",
        };
      }

      if (!response.ok) {
        return {
          valid: false,
          modelCount: 0,
          error: `Connection failed: ${response.status}`,
        };
      }

      const data = (await response.json()) as any;
      const models = Array.isArray(data) ? data : data.data || data.models || [];

      return {
        valid: true,
        modelCount: models.length,
      };
    } catch (error) {
      return {
        valid: false,
        modelCount: 0,
        error: `Cannot connect to ${baseUrl}: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};
