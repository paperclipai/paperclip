import { api } from "./client";

// ─── Types imported from shared (mirrored for convenience) ──────────────

export type KnowledgeDocumentStatus =
  | "draft"
  | "in_review"
  | "published"
  | "archived";

export type KnowledgeReviewStatus =
  | "pending"
  | "approved"
  | "changes_requested";

export interface KnowledgeDocument {
  id: string;
  companyId: string;
  title: string;
  summary?: string;
  body: string;
  status: KnowledgeDocumentStatus;
  version: number;
  authorAgentId?: string;
  sourceIssueId?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export interface KnowledgeDocumentListItem {
  id: string;
  title: string;
  summary?: string;
  status: KnowledgeDocumentStatus;
  version: number;
  authorAgentId?: string;
  sourceIssueId?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  revisionCount: number;
  latestReviewStatus?: KnowledgeReviewStatus;
}

export interface KnowledgeDocumentListPage {
  items: KnowledgeDocumentListItem[];
  nextCursor?: string;
  total?: number;
}

export interface KnowledgeDocumentRevision {
  id: string;
  documentId: string;
  version: number;
  title: string;
  summary?: string;
  body: string;
  changeDescription?: string;
  authorAgentId?: string;
  createdAt: string;
}

export interface KnowledgeDocumentDiff {
  oldVersion: number;
  newVersion: number;
  titleChanged: boolean;
  oldTitle?: string;
  newTitle: string;
  summaryChanged: boolean;
  oldSummary?: string;
  newSummary?: string;
  bodyDiff: string;
  changeDescription?: string;
}

export interface KnowledgeSourceBacklink {
  id: string;
  documentId: string;
  sourceIssueId: string;
  sourceType: string;
  createdAt: string;
}

export interface SearchPublishedResult {
  id: string;
  title: string;
  summary?: string;
  score: number;
}

// ─── Query helpers ──────────────────────────────────────────────────────

function buildQuery(params?: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// ─── API Client ─────────────────────────────────────────────────────────

export const knowledgeApi = {
  /**
   * List knowledge documents with cursor-based pagination and status filter.
   */
  list: (
    companyId: string,
    params: {
      status?: KnowledgeDocumentStatus;
      cursor?: string;
      limit?: number;
      search?: string;
    } = {},
  ): Promise<KnowledgeDocumentListPage> => {
    const query: Record<string, string | number | undefined> = {};
    if (params.status) query.status = params.status;
    if (params.cursor) query.cursor = params.cursor;
    if (params.limit) query.limit = params.limit;
    if (params.search) query.search = params.search;
    return api.get<KnowledgeDocumentListPage>(
      `/companies/${companyId}/knowledge${buildQuery(query)}`,
    );
  },

  /**
   * Get a single knowledge document by ID.
   */
  get: async (companyId: string, documentId: string): Promise<KnowledgeDocument | null> => {
    try {
      return await api.get<KnowledgeDocument>(
        `/companies/${companyId}/knowledge/${documentId}`,
      );
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  },

  /**
   * Create a new knowledge document.
   */
  create: (
    companyId: string,
    data: { title: string; summary?: string; body?: string; sourceIssueId?: string },
  ): Promise<KnowledgeDocument> => {
    return api.post<KnowledgeDocument>(`/companies/${companyId}/knowledge`, data);
  },

  /**
   * Update a draft knowledge document.
   */
  update: (
    companyId: string,
    documentId: string,
    data: { title?: string; summary?: string; body?: string },
  ): Promise<KnowledgeDocument> => {
    return api.patch<KnowledgeDocument>(
      `/companies/${companyId}/knowledge/${documentId}`,
      data,
    );
  },

  /**
   * Delete a draft or archived knowledge document.
   */
  remove: (companyId: string, documentId: string): Promise<void> => {
    return api.delete<void>(`/companies/${companyId}/knowledge/${documentId}`);
  },

  /**
   * Submit a draft document for review.
   */
  submitForReview: (
    companyId: string,
    documentId: string,
    data: { reviewerAgentId?: string } = {},
  ): Promise<{ document: KnowledgeDocument; revision: KnowledgeDocumentRevision }> => {
    return api.post(
      `/companies/${companyId}/knowledge/${documentId}/submit-review`,
      data,
    );
  },

  /**
   * Review a document (approve or request changes).
   */
  review: (
    companyId: string,
    documentId: string,
    data: { status: "approved" | "changes_requested"; comment?: string },
  ): Promise<{ document: KnowledgeDocument; review: { id: string; status: string } }> => {
    return api.post(
      `/companies/${companyId}/knowledge/${documentId}/review`,
      data,
    );
  },

  /**
   * Publish an approved document.
   */
  publish: (
    companyId: string,
    documentId: string,
    data: { changeDescription?: string } = {},
  ): Promise<{ document: KnowledgeDocument; revision: KnowledgeDocumentRevision }> => {
    return api.post(
      `/companies/${companyId}/knowledge/${documentId}/publish`,
      data,
    );
  },

  /**
   * Archive a published document.
   */
  archive: (companyId: string, documentId: string): Promise<KnowledgeDocument> => {
    return api.post<KnowledgeDocument>(
      `/companies/${companyId}/knowledge/${documentId}/archive`,
      {},
    );
  },

  /**
   * List all revisions for a document.
   */
  listRevisions: (
    companyId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentRevision[]> => {
    return api.get<KnowledgeDocumentRevision[]>(
      `/companies/${companyId}/knowledge/${documentId}/revisions`,
    );
  },

  /**
   * Get a specific revision.
   */
  getRevision: (
    companyId: string,
    documentId: string,
    revisionId: string,
  ): Promise<KnowledgeDocumentRevision> => {
    return api.get<KnowledgeDocumentRevision>(
      `/companies/${companyId}/knowledge/${documentId}/revisions/${revisionId}`,
    );
  },

  /**
   * Diff two revisions.
   */
  diff: (
    companyId: string,
    documentId: string,
    revA: string,
    revB: string,
  ): Promise<KnowledgeDocumentDiff> => {
    return api.get<KnowledgeDocumentDiff>(
      `/companies/${companyId}/knowledge/${documentId}/revisions/${revA}/diff/${revB}`,
    );
  },

  /**
   * List backlinks for a document.
   */
  listBacklinks: (
    companyId: string,
    documentId: string,
  ): Promise<KnowledgeSourceBacklink[]> => {
    return api.get<KnowledgeSourceBacklink[]>(
      `/companies/${companyId}/knowledge/${documentId}/backlinks`,
    );
  },

  /**
   * Search across all published knowledge documents.
   */
  searchPublished: (
    companyId: string,
    q: string,
    limit?: number,
  ): Promise<SearchPublishedResult[]> => {
    const query = buildQuery({ q, limit });
    return api.get<SearchPublishedResult[]>(
      `/companies/${companyId}/knowledge/search${query}`,
    );
  },
};