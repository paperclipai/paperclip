export const RUN_RECALL_DEFAULT_LIMIT = 50 as const;
export const RUN_RECALL_MAX_LIMIT = 200 as const;
export const RUN_RECALL_MAX_QUERY_LENGTH = 200 as const;
export const RUN_RECALL_MAX_TOKENS = 8 as const;
export const RUN_RECALL_SNIPPET_MAX_CHARS = 240 as const;

export type RunRecallRunMatchedField =
  | "error"
  | "errorCode"
  | "resultSummary";

export interface RunRecallRunMatch {
  runId: string;
  status: string;
  agentId: string;
  agentName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  matchedField: RunRecallRunMatchedField;
  snippet: string;
}

export interface RunRecallActivityMatch {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface RunRecallResponse {
  query: string;
  runs: RunRecallRunMatch[];
  activity: RunRecallActivityMatch[];
}
