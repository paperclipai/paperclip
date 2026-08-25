export type KnowledgeBase = {
  id: string;
  name: string;
  type?: string;
  knowledgeCount: number;
  chunkCount: number;
  processingCount: number;
};

export type SearchResult = {
  knowledgeBaseId?: string;
  knowledgeId: string;
  title: string;
  filename?: string;
  source?: string;
  chunkIndex: number;
  score?: number;
  content: string;
  truncated: boolean;
};

export type DocumentSummary = {
  id: string;
  title: string;
  summary?: string;
  source?: string;
  status?: string;
};

export type DocumentChunk = { index: number; content: string; truncated: boolean };

export type WikiPageSummary = {
  slug: string;
  title: string;
  summary?: string;
  pageType?: string;
  status?: string;
  updatedAt?: string;
};

export type WikiPage = WikiPageSummary & {
  content: string;
  sourceRefs?: Array<string | Record<string, unknown>>;
  inLinks?: string[];
  outLinks?: string[];
};

export type WikiSearchResult = {
  slug: string;
  title: string;
  summary?: string;
  excerpt?: string;
  score?: number;
};

export type UpstreamEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: unknown;
};

export type IngestResult = { id: string; status?: string; taskId?: string };

export type WikiDiagnostics = {
  stats?: Record<string, unknown>;
  lintCounts?: Record<string, number>;
  issues?: Array<Record<string, unknown>>;
  warnings?: string[];
};
