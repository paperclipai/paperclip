import type {
  DocumentAnnotationAnchorConfidence,
  DocumentAnnotationAnchorState,
  DocumentAnnotationThreadStatus,
  IssueCommentAuthorType,
} from "../constants.js";

export interface DocumentTextPosition {
  sourceStart: number;
  sourceEnd: number;
}

export interface DocumentTextProjection {
  source: string;
  text: string;
  positions: DocumentTextPosition[];
}

export interface DocumentTextRange {
  text: string;
  normalizedStart: number;
  normalizedEnd: number;
  markdownStart: number;
  markdownEnd: number;
}

export interface DocumentAnnotationTextQuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface DocumentAnnotationTextPositionSelector {
  normalizedStart: number;
  normalizedEnd: number;
  markdownStart: number;
  markdownEnd: number;
}

export interface DocumentAnnotationAnchorSelector {
  quote: DocumentAnnotationTextQuoteSelector;
  position: DocumentAnnotationTextPositionSelector;
}

export interface DocumentAnnotationAnchorSnapshot {
  selectedText: string;
  prefixText: string;
  suffixText: string;
  normalizedStart: number;
  normalizedEnd: number;
  markdownStart: number;
  markdownEnd: number;
}

export interface DocumentAnnotationThread {
  id: string;
  companyId: string;
  issueId: string;
  documentId: string;
  documentKey: string;
  status: DocumentAnnotationThreadStatus;
  anchorState: DocumentAnnotationAnchorState;
  anchorConfidence: DocumentAnnotationAnchorConfidence;
  originalRevisionId: string | null;
  originalRevisionNumber: number;
  currentRevisionId: string | null;
  currentRevisionNumber: number;
  selectedText: string;
  prefixText: string;
  suffixText: string;
  normalizedStart: number;
  normalizedEnd: number;
  markdownStart: number;
  markdownEnd: number;
  anchorSelector: DocumentAnnotationAnchorSelector;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentAnnotationComment {
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
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentAnnotationAnchorRemapSnapshot {
  id: string;
  companyId: string;
  threadId: string;
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

export interface DocumentAnnotationThreadWithComments extends DocumentAnnotationThread {
  comments: DocumentAnnotationComment[];
}

export interface CreateDocumentAnnotationThreadRequest {
  baseRevisionId: string;
  baseRevisionNumber: number;
  selector: DocumentAnnotationAnchorSelector;
  body: string;
}

export interface CreateDocumentAnnotationCommentRequest {
  body: string;
}

export interface UpdateDocumentAnnotationThreadRequest {
  status?: DocumentAnnotationThreadStatus;
}
