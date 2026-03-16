import type { LlmProviderModule } from "../types.js";

export const ollamaModule: LlmProviderModule = {
  type: "ollama",
  label: "Ollama (Local)",

  async listModels(userApiKey?: string, baseUrl?: string) {
    // API key not used for Ollama
    const url = baseUrl || "http://localhost:11434";

    try {
      const response = await fetch(`${url}/api/tags`);

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as any;
      const models = data.models || [];

      return models.map((m: any) => ({
        id: m.name,
        metadata: {
          name: m.name,
          size: m.size,
          digest: m.digest,
          modifiedAt: m.modified_at,
        },
      }));
    } catch {
      return [];
    }
  },

  async validateCredential(apiKey: string, baseUrl?: string) {
    // API key not used for Ollama
    const url = baseUrl || "http://localhost:11434";

    try {
      const response = await fetch(`${url}/api/tags`);

      if (!response.ok) {
        return {
          valid: false,
          modelCount: 0,
          error: `Connection failed: ${response.status}`,
        };
      }

      const data = (await response.json()) as any;
      const modelCount = (data.models || []).length;

      return {
        valid: true,
        modelCount,
      };
    } catch (error) {
      return {
        valid: false,
        modelCount: 0,
        error: `Cannot connect to Ollama at ${url}: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
};
