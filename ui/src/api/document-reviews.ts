import type {
  AcceptDocumentSuggestionRequest,
  CompanyDocument,
  CreateDocumentReviewCommentRequest,
  CreateDocumentReviewThreadRequest,
  CreateDocumentSuggestionCommentRequest,
  CreateDocumentSuggestionRequest,
  DocumentReviewComment,
  DocumentReviewIndex,
  DocumentReviewThreadStatus,
  DocumentReviewThreadWithComments,
  DocumentSuggestion,
  DocumentSuggestionComment,
  RejectDocumentSuggestionRequest,
  ResolveDocumentSuggestionRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export type DocumentReviewIndexStatus = "open" | "all";

/**
 * The accept endpoint returns the resulting revision + the updated document so
 * the caller can refresh the body and open a diff. We keep the shape loose for
 * the fields the detail view actually consumes.
 */
export interface AcceptDocumentSuggestionResult {
  suggestion: DocumentSuggestion;
  document: CompanyDocument;
  revision: { id: string; revisionNumber: number };
}

/**
 * Document review surface (anchored comments live in `document-annotations`;
 * this module covers the *review-index*, document-level review threads, and
 * suggested edits — the pieces the detail/review view layers on top).
 */
export const documentReviewsApi = {
  reviewIndex: (
    issueId: string,
    key: string,
    options: { rev?: number; status?: DocumentReviewIndexStatus; includeComments?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.rev !== undefined) params.set("rev", String(options.rev));
    if (options.status) params.set("status", options.status);
    if (options.includeComments) params.set("includeComments", "true");
    const qs = params.toString();
    return api.get<DocumentReviewIndex>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/review-index${qs ? `?${qs}` : ""}`,
    );
  },

  // --- Document-level / overall review threads (anchor: null) ----------------
  createReviewThread: (issueId: string, key: string, data: CreateDocumentReviewThreadRequest) =>
    api.post<DocumentReviewThreadWithComments>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/review-comments`,
      data,
    ),
  addReviewComment: (
    issueId: string,
    key: string,
    threadId: string,
    data: CreateDocumentReviewCommentRequest,
  ) =>
    api.post<DocumentReviewComment>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/review-comments/${threadId}/comments`,
      data,
    ),
  updateReviewThreadStatus: (
    issueId: string,
    key: string,
    threadId: string,
    status: DocumentReviewThreadStatus,
  ) =>
    api.patch<DocumentReviewThreadWithComments>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/review-comments/${threadId}`,
      { status },
    ),

  // --- Suggested edits -------------------------------------------------------
  createSuggestion: (issueId: string, key: string, data: CreateDocumentSuggestionRequest) =>
    api.post<DocumentSuggestion>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/suggestions`,
      data,
    ),
  addSuggestionComment: (
    issueId: string,
    key: string,
    suggestionId: string,
    data: CreateDocumentSuggestionCommentRequest,
  ) =>
    api.post<DocumentSuggestionComment>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/suggestions/${suggestionId}/comments`,
      data,
    ),
  acceptSuggestion: (
    issueId: string,
    key: string,
    suggestionId: string,
    data: AcceptDocumentSuggestionRequest,
  ) =>
    api.post<AcceptDocumentSuggestionResult>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/suggestions/${suggestionId}/accept`,
      data,
    ),
  rejectSuggestion: (
    issueId: string,
    key: string,
    suggestionId: string,
    data: RejectDocumentSuggestionRequest,
  ) =>
    api.post<DocumentSuggestion>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/suggestions/${suggestionId}/reject`,
      data,
    ),
  // "Resolve" = handled outside review / no longer applies — a first-class status
  // distinct from reject (disagreement) so the audit trail keeps the two apart.
  resolveSuggestion: (
    issueId: string,
    key: string,
    suggestionId: string,
    data: ResolveDocumentSuggestionRequest = {},
  ) =>
    api.post<DocumentSuggestion>(
      `/issues/${issueId}/documents/${encodeURIComponent(key)}/suggestions/${suggestionId}/resolve`,
      data,
    ),
};
