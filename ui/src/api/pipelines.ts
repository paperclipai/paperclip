import type {
  Issue,
  PipelineAutomationRetryCleanupOptions,
  PipelineAutomationRetryPlan,
  PipelineAutomationRetryScope,
  PipelineCaseConversationSource,
  PipelineCaseLiveness,
  PipelineHealthReport,
  RoutineEnvConfig,
} from "@paperclipai/shared";
import { api } from "./client";

export type { PipelineHealthReport, PipelineHealthWarning } from "@paperclipai/shared";

export type PipelineConnectionRef =
  | string
  | {
      id?: string | null;
      pipelineId?: string | null;
      upstreamPipelineId?: string | null;
      downstreamPipelineId?: string | null;
      feedsIntoPipelineId?: string | null;
      fedByPipelineId?: string | null;
      direction?: string | null;
    };

export interface PipelineConnections {
  upstreamPipelineIds?: string[];
  downstreamPipelineIds?: string[];
  feedsIntoPipelineId?: string | null;
  downstreamPipelineId?: string | null;
  feedsInto?: PipelineConnectionRef[];
  fedBy?: PipelineConnectionRef[];
  upstream?: PipelineConnectionRef[];
  downstream?: PipelineConnectionRef[];
  [key: string]: unknown;
}

export interface PipelineListItem {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  projectId: string | null;
  enforceTransitions: boolean;
  archivedAt: Date | string | null;
  stageCount: number;
  stages?: PipelineStage[];
  openCaseCount: number;
  attentionCount?: number | null;
  inMotionCount?: number | null;
  descendantActiveWorkCount?: number | null;
  lastActivityAt?: Date | string | null;
  connections?: PipelineConnections | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineStage {
  id: string;
  pipelineId: string;
  key: string;
  name: string;
  kind: string;
  position: number;
  config?: Record<string, unknown> | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PipelineDetail extends PipelineListItem {
  stages: PipelineStage[];
  transitions: Array<{ fromStageId: string; toStageId: string; label?: string | null }>;
  documentKeys?: Array<{ key: string; documentId: string }>;
}

export interface PipelineTransitionEdge {
  fromStageKey: string;
  toStageKey: string;
  label?: string | null;
}

export interface PipelineDocumentPayload {
  link: { key: string; documentId: string; [key: string]: unknown };
  document: { id: string; title: string; latestBody?: string | null; [key: string]: unknown };
  revision?: { body?: string | null; title?: string | null; [key: string]: unknown } | null;
}

export interface PipelineDocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  pipelineId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: string;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date | string;
}

export type PipelineIntakeFieldType = "select" | "text" | "multiline";

export interface PipelineIntakeField {
  key: string;
  label: string;
  type: PipelineIntakeFieldType;
  options?: string[];
  required?: boolean;
}

export interface PipelineIntakeForm {
  pipelineId: string;
  stageId: string | null;
  stageName?: string | null;
  fields: PipelineIntakeField[];
}

export interface PipelineCase {
  id: string;
  companyId?: string;
  pipelineId: string;
  stageId: string | null;
  caseKey?: string | null;
  title: string;
  summary?: string | null;
  fields?: Record<string, unknown> | null;
  workspaceRef?: Record<string, unknown> | null;
  parentCaseId?: string | null;
  parentCaseVersion?: number | null;
  requestKey?: string | null;
  version?: number;
  pendingSuggestion?: PipelineCasePendingSuggestion | null;
  terminalKind?: string | null;
  terminalAt?: Date | string | null;
  childCount?: number;
  terminalChildCount?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PipelineCaseActiveWork {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  issueRole?: "work" | "automation";
  agentId: string;
  agentName: string;
  startedAt: Date | string | null;
}

export interface PipelineCasePendingSuggestion {
  id: string;
  toStageKey: string;
  rationale: string;
  confidence?: number;
  suggestedByAgentId?: string;
  runId?: string;
  createdAt: Date | string;
}

export interface PipelineCaseDetail {
  case: PipelineCase;
  /** Derived from the pipeline (invisible/internal): used for display + ingest checks. */
  caseType?: string;
  stage: PipelineStage;
  pipeline: PipelineDetail;
  allowedNextStages: PipelineStage[];
  links: PipelineCaseIssueLink[];
  blockers: PipelineCaseBlocker[];
  blocks: PipelineCaseBlocker[];
  childrenSummary: {
    childCount: number;
    terminalChildCount: number;
    loadedChildren: number;
    descendantActiveWorkCount?: number;
  };
  parentCase?: {
    case: PipelineCase;
    stage: PipelineStage;
    pipeline: { id: string; key: string; name: string };
  } | null;
  activeWork?: PipelineCaseActiveWork | null;
  liveness?: PipelineCaseLiveness | null;
  conversationSource?: PipelineCaseConversationSource | null;
  pendingSuggestion?: PipelineCasePendingSuggestion | null;
}

export interface PipelineCaseIssueLink {
  id: string;
  companyId: string;
  caseId: string;
  issueId: string;
  role: "origin" | "conversation" | "work" | "automation";
  createdByRunId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineCaseIssueLinkWithIssue {
  link: PipelineCaseIssueLink;
  issue: Issue;
}

export interface PipelineCaseBlocker {
  id: string;
  companyId: string;
  caseId: string;
  blockedByCaseId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineCaseEvent {
  id: string;
  companyId: string;
  caseId: string;
  type: string;
  actorType: "user" | "agent" | "system";
  actorUserId?: string | null;
  actorAgentId?: string | null;
  runId?: string | null;
  fromStageId?: string | null;
  toStageId?: string | null;
  payload?: Record<string, unknown> | null;
  fromStage?: { id: string; key: string; name: string; kind: string } | null;
  toStage?: { id: string; key: string; name: string; kind: string } | null;
  actorAgent?: { id: string; name: string } | null;
  automation?: {
    routine: { id: string; title: string } | null;
    issue: { id: string; identifier: string | null; title: string; status: string } | null;
    routineRunId?: string | null;
    stage?: { id: string; key: string; name: string; kind: string } | null;
  };
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineCaseEventsPage {
  items: PipelineCaseEvent[];
  pagination: {
    limit: number;
    offset: number;
    nextOffset: number | null;
    hasMore: boolean;
    order: "asc" | "desc";
  };
}

export interface PipelineAttentionCaseRef {
  id: string;
  caseKey: string | null;
  title: string;
  summary?: string | null;
  version: number;
  terminalKind?: string | null;
  parentCaseId?: string | null;
  updatedAt: Date | string;
  createdAt: Date | string;
  pipeline: { id: string; key: string; name: string };
  stage: { id: string; key: string; name: string; kind: string };
}

export interface PipelineAttentionSuggestion {
  case: PipelineAttentionCaseRef;
  suggestion: {
    id: string;
    fromStageKey: string;
    fromStageName: string;
    toStageKey: string;
    toStageName: string | null;
    rationale: string;
    confidence?: number | null;
    createdAt: Date | string;
    suggestedBy: { agentId: string; agentName: string } | null;
  };
}

export interface PipelineAttentionReview {
  case: PipelineAttentionCaseRef;
  review: {
    expectedVersion: number;
    approveToStageKey: string | null;
    rejectToStageKey: string | null;
    requestChangesToStageKey: string | null;
    requireRejectReason: boolean;
    reviewerKind: string;
  };
}

export interface PipelineAttentionHeadsUp {
  case: PipelineAttentionCaseRef;
  drift: {
    eventId: string;
    createdAt: Date | string;
    previousVersion: number | null;
    version: number | null;
    upstream: {
      caseId: string | null;
      caseKey: string | null;
      title: string | null;
      pipelineId: string | null;
      pipelineName: string | null;
    };
  };
  activeWork?: PipelineCaseActiveWork | null;
  workIssue?: Record<string, unknown> | null;
}

export interface PipelineAttentionFeed {
  suggestions: PipelineAttentionSuggestion[];
  reviews: PipelineAttentionReview[];
  headsUp: PipelineAttentionHeadsUp[];
  counts: { suggestions: number; reviews: number; headsUp: number };
}

export interface PipelineReviewConfig {
  approveToStageKey?: string | null;
  rejectToStageKey?: string | null;
  requestChangesToStageKey?: string | null;
  requireRejectReason?: boolean;
  reviewerKind?: string;
  [key: string]: unknown;
}

export interface PipelineReviewCaseRow {
  case: PipelineCase;
  pipeline: { id: string; key: string; name: string; [key: string]: unknown };
  stage: PipelineStage;
  parentCase?: PipelineCase | null;
  pendingSuggestion?: PipelineCasePendingSuggestion | null;
  reviewConfig: PipelineReviewConfig;
}

export type PipelineReviewDecision = "approve" | "reject" | "request_changes";

export interface PipelineBulkReviewResult {
  results: Array<{
    caseId: string;
    ok: boolean;
    result?: unknown;
    error?: { status?: number; message?: string; code?: string; details?: Record<string, unknown> };
  }>;
}

export interface PipelineCompanyCaseEvent extends PipelineCaseEvent {
  case: { id: string; caseKey: string | null; title: string; terminalKind?: string | null };
  pipeline: { id: string; key: string; name: string };
  fromStage?: { id: string; key: string; name: string; kind: string } | null;
  toStage?: { id: string; key: string; name: string; kind: string } | null;
  actorAgent?: { id: string; name: string } | null;
}

export interface PipelineCompanyCaseEventsPage {
  items: PipelineCompanyCaseEvent[];
  pagination: {
    limit: number;
    offset: number;
    nextOffset: number | null;
    hasMore: boolean;
  };
}

export interface PipelineCaseChildrenTreeNode {
  id: string;
  caseKey: string | null;
  title: string;
  terminalKind?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  pipeline: { id: string; key: string; name: string };
  stage: { id: string; key: string; name: string; kind: string };
  rollup?: { total: number; done: number; dropped: number; inMotion: number } | null;
  childGroups?: Array<{
    pipeline: { id: string; key: string; name: string };
    cases: PipelineCaseChildrenTreeNode[];
  }>;
}

export interface PipelineCaseChildrenTree {
  case: PipelineCaseChildrenTreeNode;
  rollup?: { total: number; done: number; dropped: number; inMotion: number } | null;
  childGroups?: Array<{
    pipeline: { id: string; key: string; name: string };
    cases: PipelineCaseChildrenTreeNode[];
  }>;
  truncated?: boolean;
  totalNodes?: number;
}

export interface PipelineCaseChildRow {
  case: PipelineCase;
  stage: PipelineStage;
  activeWork?: PipelineCaseActiveWork | null;
  descendantActiveWorkCount?: number;
}

export type PipelineCaseChildrenResponse = PipelineCaseChildRow[];

export type PipelineBatchIngestResult =
  | { ok: true; case: PipelineCase; created: boolean }
  | {
      ok: false;
      caseKey: string | null;
      error?: {
        status?: number;
        message?: string;
        details?: Record<string, unknown>;
      };
    };

export const pipelinesApi = {
  list: (companyId: string) => api.get<PipelineListItem[]>(`/companies/${companyId}/pipelines`),
  create: (
    companyId: string,
    data: { key: string; name: string; description?: string | null; projectId?: string | null },
  ) => api.post<PipelineListItem & { stages?: PipelineStage[] }>(`/companies/${companyId}/pipelines`, data),
  get: (pipelineId: string) => api.get<PipelineDetail>(`/pipelines/${pipelineId}`),
  getHealth: (pipelineId: string) => api.get<PipelineHealthReport>(`/pipelines/${pipelineId}/health`),
  update: (
    pipelineId: string,
    data: { name?: string; description?: string | null; enforceTransitions?: boolean; archived?: boolean },
  ) => api.patch<PipelineListItem>(`/pipelines/${pipelineId}`, data),
  createStage: (
    pipelineId: string,
    data: { key: string; name: string; kind: string; position: number; config?: Record<string, unknown> },
  ) => api.post<PipelineStage>(`/pipelines/${pipelineId}/stages`, data),
  updateStage: (
    pipelineId: string,
    stageId: string,
    data: { key?: string; name?: string; kind?: string; position?: number; config?: Record<string, unknown> },
  ) => api.patch<PipelineStage>(`/pipelines/${pipelineId}/stages/${stageId}`, data),
  // Stage secrets live on the backing automation routine's env, not in stage
  // config. This narrow route updates only that env (and its secret bindings)
  // so saving secrets never clobbers unrelated stage settings.
  updateStageAutomationEnv: (
    pipelineId: string,
    stageId: string,
    data: { env: RoutineEnvConfig | null; baseRoutineRevisionId?: string | null },
  ) => api.patch<PipelineStage>(`/pipelines/${pipelineId}/stages/${stageId}/automation-env`, data),
  deleteStage: (
    pipelineId: string,
    stageId: string,
    data?: { moveCasesToStageId?: string | null },
  ) => {
    const params = new URLSearchParams();
    if (data?.moveCasesToStageId) params.set("moveCasesToStageId", data.moveCasesToStageId);
    const qs = params.toString();
    return api.delete<{ deleted: boolean }>(`/pipelines/${pipelineId}/stages/${stageId}${qs ? `?${qs}` : ""}`);
  },
  setTransitions: (
    pipelineId: string,
    data: { transitions: PipelineTransitionEdge[]; enforceTransitions?: boolean },
  ) =>
    api.put<{ transitions: Array<{ fromStageId: string; toStageId: string; label?: string | null }> }>(
      `/pipelines/${pipelineId}/transitions`,
      data,
    ),
  getDocument: (pipelineId: string, key: string) =>
    api.get<PipelineDocumentPayload>(`/pipelines/${pipelineId}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (pipelineId: string, key: string, data: { title?: string; body: string; baseRevisionId?: string | null }) =>
    api.put<{ document: PipelineDocumentPayload["document"]; revision: NonNullable<PipelineDocumentPayload["revision"]> }>(
      `/pipelines/${pipelineId}/documents/${encodeURIComponent(key)}`,
      data,
    ),
  listDocumentRevisions: (pipelineId: string, key: string) =>
    api.get<PipelineDocumentRevision[]>(`/pipelines/${pipelineId}/documents/${encodeURIComponent(key)}/revisions`),
  restoreDocumentRevision: (pipelineId: string, key: string, revisionId: string) =>
    api.post<{
      document: PipelineDocumentPayload["document"];
      revision: PipelineDocumentRevision;
      restoredFromRevisionId: string;
      restoredFromRevisionNumber: number;
    }>(`/pipelines/${pipelineId}/documents/${encodeURIComponent(key)}/revisions/${revisionId}/restore`, {}),
  getIntakeForm: (pipelineId: string) => api.get<PipelineIntakeForm>(`/pipelines/${pipelineId}/intake-form`),
  listCases: (pipelineId: string, filters?: { parentCaseId?: string; terminal?: boolean }) => {
    const params = new URLSearchParams();
    if (filters?.parentCaseId) params.set("parentCaseId", filters.parentCaseId);
    if (filters?.terminal !== undefined) params.set("terminal", filters.terminal ? "true" : "false");
    const qs = params.toString();
    return api.get<PipelineCaseChildRow[]>(`/pipelines/${pipelineId}/cases${qs ? `?${qs}` : ""}`);
  },
  getCase: (caseId: string) => api.get<PipelineCaseDetail>(`/cases/${caseId}`),
  getCaseChildren: (caseId: string) =>
    api.get<PipelineCaseChildrenResponse>(`/cases/${caseId}/children`),
  getCaseChildrenTree: (caseId: string) =>
    api.get<PipelineCaseChildrenTree>(`/cases/${caseId}/children/tree`),
  getCaseEvents: (caseId: string, filters?: { limit?: number; offset?: number; order?: "asc" | "desc" }) => {
    const params = new URLSearchParams();
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    if (filters?.order) params.set("order", filters.order);
    const qs = params.toString();
    return api.get<PipelineCaseEventsPage>(`/cases/${caseId}/events${qs ? `?${qs}` : ""}`);
  },
  getCaseIssueLinks: (caseId: string) =>
    api.get<PipelineCaseIssueLinkWithIssue[]>(`/cases/${caseId}/issue-links`),
  createIssueLink: (
    caseId: string,
    data:
      | { issueId: string; role: PipelineCaseIssueLink["role"] }
      | { role: "conversation"; issueId?: undefined },
  ) => data.issueId
    ? api.post<PipelineCaseIssueLink>(`/cases/${caseId}/issue-links`, data)
    : api.post<{ issue: Issue; created: boolean }>(`/cases/${caseId}/open-conversation`, {}),
  updateCase: (
    caseId: string,
    data: {
      title?: string;
      summary?: string | null;
      fields?: Record<string, unknown>;
      parentCaseId?: string | null;
      expectedVersion?: number;
      leaseToken?: string | null;
    },
  ) => api.patch<{ case: PipelineCase; event?: PipelineCaseEvent | null } | PipelineCase>(`/cases/${caseId}`, data),
  acknowledgeDrift: (caseId: string, data?: { expectedVersion?: number }) =>
    api.post<{ case: PipelineCase; event: PipelineCaseEvent | null; acknowledged: boolean }>(
      `/cases/${caseId}/acknowledge-drift`,
      data ?? {},
    ),
  resolveSuggestion: (
    caseId: string,
    data: {
      suggestionId: string;
      resolution: "accept" | "dismiss";
      expectedVersion?: number;
      reason?: string | null;
      leaseToken?: string | null;
    },
  ) => api.post<unknown>(`/cases/${caseId}/resolve-suggestion`, data),
  transitionCase: (
    caseId: string,
    data: {
      toStageKey: string;
      expectedVersion: number;
      reason?: string | null;
      leaseToken?: string | null;
      acceptSuggestionId?: string;
      force?: boolean;
    },
  ) => api.post<unknown>(`/cases/${caseId}/transition`, data),
  rerunCurrentStageAutomation: (caseId: string) =>
    api.post<unknown>(`/cases/${caseId}/automation/current-stage/rerun`, {}),
  getAutomationRetryPlan: (caseId: string, scope: PipelineAutomationRetryScope) =>
    api.get<PipelineAutomationRetryPlan>(`/cases/${caseId}/automation/retry-plan?scope=${encodeURIComponent(scope)}`),
  retryStageAutomation: (
    caseId: string,
    data: { scope: PipelineAutomationRetryScope; expectedVersion: number; cleanup: PipelineAutomationRetryCleanupOptions },
  ) => api.post<unknown>(`/cases/${caseId}/automation/retry`, data),
  retryAutomation: (caseId: string, automationId: string) =>
    api.post<unknown>(`/cases/${caseId}/automations/${automationId}/retry`, {}),
  ingestCasesBatch: (pipelineId: string, data: {
    items: Array<{
      caseKey?: string | null;
      title: string;
      fields?: Record<string, unknown>;
      stageKey?: string | null;
      parentCaseId?: string | null;
      requestKey?: string | null;
      blockedByCaseIds?: string[];
      blockedByCaseKeys?: string[];
    }>;
  }) =>
    api.post<PipelineBatchIngestResult[]>(`/pipelines/${pipelineId}/cases/batch`, data),
  listAttention: (companyId: string, options?: { limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return api.get<PipelineAttentionFeed>(`/companies/${companyId}/pipelines-attention${qs ? `?${qs}` : ""}`);
  },
  listReviewCases: (companyId: string, filters?: { pipelineId?: string; parentCaseId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.pipelineId) params.set("pipelineId", filters.pipelineId);
    if (filters?.parentCaseId) params.set("parentCaseId", filters.parentCaseId);
    const qs = params.toString();
    return api.get<PipelineReviewCaseRow[]>(`/companies/${companyId}/review-cases${qs ? `?${qs}` : ""}`);
  },
  reviewCase: (
    caseId: string,
    data: {
      decision: PipelineReviewDecision;
      reason?: string | null;
      expectedVersion: number;
      leaseToken?: string | null;
    },
  ) => api.post<unknown>(`/cases/${caseId}/review`, data),
  bulkReviewCases: (
    companyId: string,
    data: {
      items: Array<{
        caseId: string;
        decision: PipelineReviewDecision;
        reason?: string | null;
        expectedVersion: number;
      }>;
    },
  ) => api.post<PipelineBulkReviewResult>(`/companies/${companyId}/review-cases/bulk`, data),
  listCompanyCaseEvents: (
    companyId: string,
    filters?: { types?: string; limit?: number; offset?: number },
  ) => {
    const params = new URLSearchParams();
    if (filters?.types) params.set("types", filters.types);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return api.get<PipelineCompanyCaseEventsPage>(`/companies/${companyId}/case-events${qs ? `?${qs}` : ""}`);
  },
};
