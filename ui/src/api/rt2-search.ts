import { api } from "./client";

export type Rt2KnowledgeSearchResult = {
  id: string;
  type: string;
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  projectId: string | null;
  title: string;
  snippet: string;
  highlight?: string;
  score: number;
  updatedAt: string;
  freshness: "fresh" | "stale" | "unknown";
  confidence: string;
  contradictionStatus: "none" | "unknown" | "unresolved" | "resolved";
  provenance: Record<string, unknown>;
  evidence: Array<{ source: string; reason: string; weight: number }>;
};

export type Rt2KnowledgeSearchResponse = {
  query: string;
  results: Rt2KnowledgeSearchResult[];
  total: number;
  searchTimeMs: number;
  searchType: "hybrid";
};

export type Rt2KnowledgeSearchInput = {
  q: string;
  limit?: number;
  offset?: number;
  projectId?: string;
  workObjectId?: string;
  sourceType?: string;
  dateFrom?: string;
  dateTo?: string;
  confidence?: string;
  contradictionStatus?: string;
};

export type Rt2SemanticIndexStatus = {
  companyId: string;
  indexedChunks: number;
  sourceCount: number;
  staleChunks: number;
  providerMode: "provider" | "fallback" | null;
  embeddingModel: string | null;
  lastRun: {
    id: string;
    mode: "full" | "changed";
    status: "running" | "completed" | "error";
    sourcesScanned: number;
    chunksRefreshed: number;
    chunksSkipped: number;
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
};

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  return search.toString();
}

export const rt2SearchApi = {
  search: (companyId: string, input: Rt2KnowledgeSearchInput) =>
    api.get<Rt2KnowledgeSearchResponse>(`/companies/${companyId}/rt2/search?${query(input)}`),
  status: (companyId: string) =>
    api.get<Rt2SemanticIndexStatus>(`/companies/${companyId}/rt2/semantic-index/status`),
  reindex: (companyId: string, mode: "full" | "changed" = "changed") =>
    api.post<{ status: "completed" | "error"; chunksRefreshed: number; chunksSkipped: number; errorMessage: string | null }>(
      `/companies/${companyId}/rt2/semantic-index/reindex`,
      { mode },
    ),
};
