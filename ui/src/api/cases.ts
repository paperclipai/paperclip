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

/** A lightweight parent reference embedded in the detail payload. */
export interface CaseParentRef {
  id: string;
  identifier: string;
  title: string;
  caseType: string;
  status: CaseStatus;
}

/** Content URL for an attachment's asset (served by the assets route). */
export function caseAttachmentUrl(attachment: CaseAttachmentRef): string {
  return `/api/assets/${attachment.asset.id}/content`;
}

export function isImageAttachment(attachment: CaseAttachmentRef): boolean {
  return attachment.asset.contentType.startsWith("image/");
}

/** The full detail payload (loadCaseDetail on the server). */
export interface CaseDetail extends CaseSummary {
  parent: CaseParentRef | null;
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

/** Run→issue attribution shared by feed rows and revisions. */
export interface CaseAttributionIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
}

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
  /** Display name of the acting agent (P4 enrichment), null for user/system. */
  actorAgentName: string | null;
  /** Issue whose run produced this event, if any (P4 attribution). */
  issue: CaseAttributionIssue | null;
}

/** One revision of a case document, with author + via-issue attribution. */
export interface CaseDocumentRevision {
  id: string;
  revisionNumber: number;
  title: string;
  format: string;
  body: string | null;
  changeSummary: string | null;
  createdAt: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  actorAgentName: string | null;
  issue: CaseAttributionIssue | null;
}

export interface CaseDocumentRevisions {
  key: string;
  document: {
    id: string;
    title: string;
    format: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number | null;
  };
  revisions: CaseDocumentRevision[];
}

/** A case linked to an issue, as returned by the issue-page rail endpoint. */
export interface IssueCaseLink {
  id: string;
  role: CaseLinkRole;
  createdAt: string;
  case: {
    id: string;
    identifier: string;
    title: string;
    caseType: string;
    status: CaseStatus;
  };
}

export interface ListCasesParams {
  type?: string;
  status?: string;
  projectId?: string;
  labelId?: string;
  /** Filter to direct children of a parent case id (P4 children tree). */
  parent?: string;
  q?: string;
  limit?: number;
}

function toQuery(params: ListCasesParams): string {
  const search = new URLSearchParams();
  if (params.type) search.set("type", params.type);
  if (params.status) search.set("status", params.status);
  if (params.projectId) search.set("projectId", params.projectId);
  if (params.labelId) search.set("labelId", params.labelId);
  if (params.parent) search.set("parent", params.parent);
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
  listChildren: (companyId: string, parentId: string) =>
    api.get<CaseSummary[]>(`/companies/${companyId}/cases${toQuery({ parent: parentId, limit: 200 })}`),
  listRevisions: (idOrIdentifier: string, key: string) =>
    api.get<CaseDocumentRevisions>(`/cases/${idOrIdentifier}/documents/${key}/revisions`),
  listForIssue: (issueIdOrIdentifier: string) =>
    api.get<IssueCaseLink[]>(`/issues/${issueIdOrIdentifier}/cases`),
};
