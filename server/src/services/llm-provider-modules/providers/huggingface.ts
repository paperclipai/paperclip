import type { LlmProviderModule } from "../types.js";

export const huggingfaceModule: LlmProviderModule = {
  type: "huggingface",
  label: "HuggingFace Inference API",

  async listModels(userApiKey?: string) {
    const apiKey = userApiKey || process.env.HUGGINGFACE_API_KEY;
    if (!apiKey) {
      return [];
    }

    try {
      const response = await fetch("https://huggingface.co/api/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as any;
      // Filter to inference models
      const models = (Array.isArray(data) ? data : [])
        .filter((m: any) => m.library_name === "transformers" && m.pipeline_tag === "text-generation")
        .slice(0, 50); // Limit to first 50

      return models.map((m: any) => ({
        id: m.id,
        metadata: {
          name: m.id,
          description: m.description || "",
          downloads: m.downloads,
        },
      }));
    } catch {
      return [];
    }
  },

  async validateCredential(apiKey: string) {
    try {
      const response = await fetch("https://huggingface.co/api/user", {
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

      return {
        valid: true,
        modelCount: 1,
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
