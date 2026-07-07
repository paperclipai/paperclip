import type { IssueLabel } from "@paperclipai/shared";
import { api } from "./client";

// -----------------------------------------------------------------------------
// Cases API (experimental — PAP-12947). Mirrors server/src/routes/cases.ts.
// Human-writable in v1 = status + labels only; everything else is agent-authored.
// -----------------------------------------------------------------------------

export const CASE_STATUSES = [
  "draft",
  "in_progress",
  "in_review",
  "approved",
  "done",
  "cancelled",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Statuses hidden by the list's default `Active` filter. */
export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = ["done", "cancelled"];

export type CaseLinkRole = "origin" | "work" | "reference";

/** A case row as returned by the list endpoint. */
export interface CaseSummary {
  id: string;
  companyId: string;
  projectId: string | null;
  caseNumber: number;
  identifier: string;
  caseType: string;
  key: string | null;
  title: string;
  summary: string | null;
  status: CaseStatus;
  fields: Record<string, unknown>;
  parentCaseId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseDocumentRef {
  key: string;
  document: {
    id: string;
    title: string;
    format: string;
    latestBody: string | null;
    latestRevisionId: string | null;
    latestRevisionNumber: number | null;
    updatedAt: string;
  };
}

export interface CaseIssueLink {
  id: string;
  caseId: string;
  issueId: string;
  role: CaseLinkRole;
  createdAt: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
    status: string;
  };
}

export interface CaseAttachmentRef {
  id: string;
  asset: {
    id: string;
    contentType: string;
    byteSize: number;
    originalFilename: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

/** The full detail payload (loadCaseDetail on the server). */
export interface CaseDetail extends CaseSummary {
  labels: IssueLabel[];
  issueLinks: CaseIssueLink[];
  documents: CaseDocumentRef[];
  attachments: CaseAttachmentRef[];
}

export type CaseEventKind =
  | "created"
  | "updated"
  | "fields_changed"
  | "status_changed"
  | "issue_linked"
  | "issue_unlinked"
  | "document_revised"
  | "child_linked"
  | "attachment_added"
  | "label_added"
  | "label_removed";

export interface CaseEvent {
  id: string;
  caseId: string;
  kind: CaseEventKind;
  actorType: "user" | "agent" | "system";
  actorUserId: string | null;
  actorAgentId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ListCasesParams {
  type?: string;
  status?: string;
  projectId?: string;
  labelId?: string;
  q?: string;
  limit?: number;
}

function toQuery(params: ListCasesParams): string {
  const search = new URLSearchParams();
  if (params.type) search.set("type", params.type);
  if (params.status) search.set("status", params.status);
  if (params.projectId) search.set("projectId", params.projectId);
  if (params.labelId) search.set("labelId", params.labelId);
  if (params.q) search.set("q", params.q);
  if (params.limit != null) search.set("limit", String(params.limit));
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export interface PatchCaseInput {
  status?: CaseStatus;
  labelIds?: string[];
}

export const casesApi = {
  list: (companyId: string, params: ListCasesParams = {}) =>
    api.get<CaseSummary[]>(`/companies/${companyId}/cases${toQuery(params)}`),
  get: (idOrIdentifier: string) => api.get<CaseDetail>(`/cases/${idOrIdentifier}`),
  patch: (idOrIdentifier: string, input: PatchCaseInput) =>
    api.patch<CaseDetail>(`/cases/${idOrIdentifier}`, input),
  listEvents: (idOrIdentifier: string, limit = 100) =>
    api.get<CaseEvent[]>(`/cases/${idOrIdentifier}/events?limit=${limit}`),
};
