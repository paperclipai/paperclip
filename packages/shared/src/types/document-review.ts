import type {
  DocumentAnnotationAnchorConfidence,
  DocumentAnnotationAnchorState,
  DocumentReviewThreadStatus,
  DocumentSuggestionInsertPosition,
  DocumentSuggestionKind,
  DocumentSuggestionStatus,
  IssueCommentAuthorType,
} from "../constants.js";
import type {
  DocumentAnnotationAnchorSelector,
  DocumentAnnotationAnchorSnapshot,
  DocumentAnnotationComment,
  DocumentAnnotationThreadWithComments,
} from "./document-annotation.js";

export interface DocumentReviewThread {
  id: string;
  companyId: string;
  issueId: string;
  documentId: string;
  documentKey: string;
  status: DocumentReviewThreadStatus;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentReviewComment {
  id: string;
  companyId: string;
  threadId: string;
  issueId: string;
  documentId: string;
  body: string;
  authorType: IssueCommentAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId: string | null;
  issueCommentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentReviewThreadWithComments extends DocumentReviewThread {
  comments: DocumentReviewComment[];
}

export interface DocumentSuggestion {
  id: string;
  companyId: string;
  issueId: string;
  documentId: string;
  documentKey: string;
  kind: DocumentSuggestionKind;
  status: DocumentSuggestionStatus;
  anchorState: DocumentAnnotationAnchorState;
  anchorConfidence: DocumentAnnotationAnchorConfidence;
  originalRevisionId: string | null;
  originalRevisionNumber: number;
  currentRevisionId: string | null;
  currentRevisionNumber: number;
  selectedText: string;
  proposedText: string | null;
  insertionPosition: DocumentSuggestionInsertPosition | null;
  prefixText: string;
  suffixText: string;
  normalizedStart: number;
  normalizedEnd: number;
  markdownStart: number;
  markdownEnd: number;
  anchorSelector: DocumentAnnotationAnchorSelector;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  acceptedByAgentId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  acceptedRevisionId: string | null;
  rejectedByAgentId: string | null;
  rejectedByUserId: string | null;
  rejectedAt: Date | null;
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentSuggestionComment {
  id: string;
  companyId: string;
  suggestionId: string;
  issueId: string;
  documentId: string;
  body: string;
  authorType: IssueCommentAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId: string | null;
  issueCommentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentSuggestionWithComments extends DocumentSuggestion {
  comments: DocumentSuggestionComment[];
}

export interface DocumentSuggestionAnchorRemapSnapshot {
  id: string;
  companyId: string;
  suggestionId: string;
  documentId: string;
  fromRevisionId: string | null;
  fromRevisionNumber: number | null;
  toRevisionId: string | null;
  toRevisionNumber: number;
  previousAnchor: DocumentAnnotationAnchorSnapshot;
  nextAnchor: DocumentAnnotationAnchorSnapshot | null;
  anchorState: DocumentAnnotationAnchorState;
  anchorConfidence: DocumentAnnotationAnchorConfidence;
  failureReason: string | null;
  createdAt: Date;
}

export interface DocumentReviewIndexCounts {
  unresolved: number;
  openAnchoredThreads: number;
  openReviewThreads: number;
  pendingSuggestions: number;
  resolvedAnchoredThreads: number;
  resolvedReviewThreads: number;
  acceptedSuggestions: number;
  rejectedSuggestions: number;
  resolvedSuggestions: number;
  staleAnchors: number;
  orphanedAnchors: number;
}

export interface DocumentReviewIndex {
  issueId: string;
  documentId: string;
  documentKey: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  counts: DocumentReviewIndexCounts;
  annotationThreads: DocumentAnnotationThreadWithComments[];
  reviewThreads: DocumentReviewThreadWithComments[];
  suggestions: DocumentSuggestionWithComments[];
}

export interface CreateDocumentReviewThreadRequest {
  body: string;
  issueCommentId?: string | null;
}

export interface CreateDocumentReviewCommentRequest {
  body: string;
  issueCommentId?: string | null;
}

export interface UpdateDocumentReviewThreadRequest {
  status?: DocumentReviewThreadStatus;
}

export interface CreateDocumentSuggestionRequest {
  baseRevisionId: string;
  baseRevisionNumber: number;
  kind: DocumentSuggestionKind;
  selector: DocumentAnnotationAnchorSelector;
  proposedText?: string | null;
  insertionPosition?: DocumentSuggestionInsertPosition | null;
  body?: string | null;
  issueCommentId?: string | null;
}

export interface CreateDocumentSuggestionCommentRequest {
  body: string;
  issueCommentId?: string | null;
}

export interface AcceptDocumentSuggestionRequest {
  baseRevisionId: string;
  changeSummary?: string | null;
}

export interface RejectDocumentSuggestionRequest {
  reason?: string | null;
}

export interface ResolveDocumentSuggestionRequest {
  /** Optional note kept for the audit trail (e.g. where it was handled). */
  note?: string | null;
}
