export interface MemoryScope {
  companyId: string;
  agentId?: string;
  projectId?: string;
  issueId?: string;
  runId?: string;
}

export interface MemorySourceRef {
  kind:
    | "issue_comment"
    | "issue_document"
    | "issue"
    | "run"
    | "activity"
    | "manual_note"
    | "external_document";
  companyId: string;
  issueId?: string;
  commentId?: string;
  runId?: string;
}

export interface MemorySnippet {
  id: string;
  text: string;
  score?: number;
  source?: MemorySourceRef;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryWriteRequest {
  scope: MemoryScope;
  source: MemorySourceRef;
  content: string;
  mode?: "append" | "upsert";
}

export interface MemoryQueryRequest {
  scope: MemoryScope;
  query: string;
  topK?: number;
}

export interface MemoryQueryResult {
  snippets: MemorySnippet[];
}

export interface MemoryBinding {
  id: string;
  companyId: string;
  key: string;
  providerType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryOperation {
  id: string;
  companyId: string;
  bindingId: string;
  operationType: "write" | "query" | "forget";
  scope: MemoryScope;
  latencyMs: number | null;
  createdAt: string;
}
