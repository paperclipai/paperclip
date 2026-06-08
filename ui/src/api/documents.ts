import type {
  CompanyDocument,
  CompanyDocumentSummary,
  DocumentBacklink,
  DocumentLink,
  DocumentLinkTargetType,
  DocumentReviewIndex,
  DocumentStatus,
  DocumentType,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CompanyDocumentListFilters {
  q?: string;
  status?: DocumentStatus[];
  type?: DocumentType[];
  ownerAgentId?: string;
  ownerUserId?: string;
  targetType?: DocumentLinkTargetType;
  targetId?: string;
  projectId?: string;
  hasOpenFeedback?: boolean;
  trustedOnly?: boolean;
  includeArchived?: boolean;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateDocumentMetadataInput {
  title?: string | null;
  status?: DocumentStatus;
  documentType?: DocumentType;
  summary?: string | null;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
}

export interface CreateDocumentLinkInput {
  targetType: DocumentLinkTargetType;
  targetId: string;
  relationship?: string;
}

function buildDocumentListQuery(filters: CompanyDocumentListFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  for (const status of filters.status ?? []) params.append("status", status);
  for (const type of filters.type ?? []) params.append("type", type);
  if (filters.ownerAgentId) params.set("ownerAgentId", filters.ownerAgentId);
  if (filters.ownerUserId) params.set("ownerUserId", filters.ownerUserId);
  if (filters.targetType) params.set("targetType", filters.targetType);
  if (filters.targetId) params.set("targetId", filters.targetId);
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.hasOpenFeedback) params.set("hasOpenFeedback", "true");
  if (filters.trustedOnly) params.set("trustedOnly", "true");
  if (filters.includeArchived) params.set("includeArchived", "true");
  if (filters.updatedAfter) params.set("updatedAfter", filters.updatedAfter);
  if (filters.updatedBefore) params.set("updatedBefore", filters.updatedBefore);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const documentsApi = {
  list: (companyId: string, filters: CompanyDocumentListFilters = {}) =>
    api.get<CompanyDocumentSummary[]>(
      `/companies/${companyId}/documents${buildDocumentListQuery(filters)}`,
    ),
  listForProject: (projectId: string, filters: CompanyDocumentListFilters = {}) =>
    api.get<CompanyDocumentSummary[]>(
      `/projects/${projectId}/documents${buildDocumentListQuery(filters)}`,
    ),
  get: (companyId: string, documentId: string) =>
    api.get<CompanyDocument>(`/companies/${companyId}/documents/${documentId}`),
  backlinks: (companyId: string, documentId: string) =>
    api.get<DocumentBacklink[]>(`/companies/${companyId}/documents/${documentId}/backlinks`),
  updateMetadata: (companyId: string, documentId: string, data: UpdateDocumentMetadataInput) =>
    api.patch<CompanyDocument>(`/companies/${companyId}/documents/${documentId}`, data),
  createLink: (companyId: string, documentId: string, data: CreateDocumentLinkInput) =>
    api.post<DocumentLink>(`/companies/${companyId}/documents/${documentId}/links`, data),
  deleteLink: (companyId: string, documentId: string, linkId: string) =>
    api.delete<void>(`/companies/${companyId}/documents/${documentId}/links/${linkId}`),
  /**
   * The review index is keyed by the owning issue + document key (the same shape
   * the issue annotation rail consumes). The library/detail surface looks it up
   * by following a document's `issue` backlink.
   */
  reviewIndex: (issueId: string, key: string, options: { rev?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.rev !== undefined) params.set("rev", String(options.rev));
    const qs = params.toString();
    return api.get<DocumentReviewIndex>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/review-index${qs ? `?${qs}` : ""}`,
    );
  },
};
