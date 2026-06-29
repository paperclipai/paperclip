import type {
  DocumentAnnotationAnchorConfidence,
  DocumentAnnotationAnchorState,
  DocumentAnnotationThreadStatus,
  IssueCommentAuthorType,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionKind,
  IssueThreadInteractionStatus,
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
  issueId: string | null;
  routineId?: string | null;
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
  issueId: string | null;
  routineId?: string | null;
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
  issueCommentId?: string | null;
}

export interface CreateDocumentAnnotationCommentRequest {
  body: string;
  issueCommentId?: string | null;
}

export interface UpdateDocumentAnnotationThreadRequest {
  status?: DocumentAnnotationThreadStatus;
}

export interface PlanReviewContextAuthor {
  type: IssueCommentAuthorType;
  id: string | null;
}

export interface PlanReviewContextComment {
  id: string;
  threadId: string;
  body: string;
  bodyTruncated: boolean;
  author: PlanReviewContextAuthor;
  createdAt: string;
  updatedAt: string;
}

export interface PlanReviewContextThread {
  id: string;
  documentKey: string;
  documentId: string;
  status: DocumentAnnotationThreadStatus;
  revisionId: string | null;
  revisionNumber: number;
  anchorState: DocumentAnnotationAnchorState;
  anchorConfidence: DocumentAnnotationAnchorConfidence;
  selectedText: string;
  selectedTextTruncated: boolean;
  prefixText: string;
  prefixTextTruncated: boolean;
  suffixText: string;
  suffixTextTruncated: boolean;
  author: PlanReviewContextAuthor;
  commentCount: number;
  comments: PlanReviewContextComment[];
  commentsTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlanReviewInteractionTargetContext {
  issueId: string;
  documentId: string | null;
  key: string;
  revisionId: string | null;
  revisionNumber: number | null;
}

export interface PlanReviewInteractionResultContext {
  outcome: string | null;
  reason: string | null;
  commentId: string | null;
}

export interface PlanReviewInteractionContext {
  id: string;
  kind: IssueThreadInteractionKind | string;
  status: IssueThreadInteractionStatus | string;
  continuationPolicy: IssueThreadInteractionContinuationPolicy | string;
  sourceCommentId: string | null;
  sourceRunId: string | null;
  target: PlanReviewInteractionTargetContext | null;
  acceptedTargetRevision: PlanReviewInteractionTargetContext | null;
  result: PlanReviewInteractionResultContext | null;
  resolvedAt: string | null;
}

export interface PlanReviewContext {
  documentKey: "plan";
  issueId: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number | null;
  threads: PlanReviewContextThread[];
  interaction: PlanReviewInteractionContext | null;
  totals: {
    openThreadCount: number;
    includedThreadCount: number;
    omittedThreadCount: number;
    commentCount: number;
    includedCommentCount: number;
    omittedCommentCount: number;
  };
  limits: {
    maxThreads: number;
    maxComments: number;
    maxBodyChars: number;
    maxTotalBodyChars: number;
    maxAnchorTextChars: number;
  };
  truncated: boolean;
}
