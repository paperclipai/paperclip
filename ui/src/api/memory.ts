import { api } from "./client";

export interface MemoryBinding {
  id: string;
  key: string;
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface MemoryOverviewStats {
  opsLast24h: number;
  failuresLast24h: number;
  lastHydrateAt: string | null;
  lastCaptureAt: string | null;
}

export interface MemoryOverview {
  binding: MemoryBinding | null;
  providerAvailable: boolean;
  stats: MemoryOverviewStats;
}

export interface MemoryOperation {
  id: string;
  operation: string;
  hookKind: string | null;
  intent: string | null;
  status: "succeeded" | "failed";
  agentId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  usageJson: { latencyMs?: number; attributionMode?: string } | null;
  errorMessage: string | null;
  createdAt: string;
  requestJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
}

export interface MemorySnippet {
  slug: string;
  title: string;
  score: number;
  text: string;
}

export const memoryApi = {
  overview: (companyId: string) =>
    api.get<MemoryOverview>(`/companies/${companyId}/memory/overview`),
  listOperations: (companyId: string, options: { limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.before) params.set("before", options.before);
    const query = params.toString();
    return api.get<{ items: MemoryOperation[] }>(
      `/companies/${companyId}/memory/operations${query ? `?${query}` : ""}`,
    );
  },
  query: (companyId: string, data: { query: string; topK?: number }) =>
    api.post<{ snippets: MemorySnippet[]; latencyMs: number }>(
      `/companies/${companyId}/memory/query`,
      data,
    ),
  note: (companyId: string, data: { title?: string; text: string }) =>
    api.post<{ slug: string }>(`/companies/${companyId}/memory/note`, data),
  updateBinding: (
    companyId: string,
    data: { enabled?: boolean; config?: Record<string, unknown> },
  ) => api.patch<MemoryBinding>(`/companies/${companyId}/memory/binding`, data),
};
