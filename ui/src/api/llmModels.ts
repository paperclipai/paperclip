export interface LlmProviderInfo {
  type: string;
  label: string;
}

export interface LlmModelsResponse {
  total: number;
  limit: number;
  offset: number;
  models: Array<{ id: string; [key: string]: any }>;
  error?: string;
}

export const llmModelsApi = {
  listProviders: async (): Promise<LlmProviderInfo[]> => {
    const res = await fetch("/api/llm-providers/providers");
    if (!res.ok) throw new Error("Failed to list providers");
    return res.json();
  },

  listModels: async (
    provider: string,
    opts?: { search?: string; limit?: number; offset?: number; apiKey?: string; baseUrl?: string },
  ): Promise<LlmModelsResponse> => {
    const params = new URLSearchParams();
    if (opts?.search) params.append("search", opts.search);
    if (opts?.limit) params.append("limit", String(opts.limit));
    if (opts?.offset) params.append("offset", String(opts.offset));
    if (opts?.apiKey) params.append("apiKey", opts.apiKey);
    if (opts?.baseUrl) params.append("baseUrl", opts.baseUrl);

    const res = await fetch(`/api/llm-providers/${provider}/models?${params}`);
    if (!res.ok) throw new Error("Failed to fetch models");
    return res.json();
  },
};
