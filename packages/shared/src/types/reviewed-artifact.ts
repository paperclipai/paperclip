import type {
  ReviewedArtifactContextType,
  ReviewedArtifactDisplayHint,
  ReviewedArtifactSelectionMode,
  ReviewedArtifactSourceType,
} from "../constants.js";

export type ReviewedArtifactIssueReviewContext = {
  type: "issue_review";
  issueId: string;
};

export type ReviewedArtifactApprovalContext = {
  type: "approval";
  approvalId: string;
  issueId?: string | null;
};

export type ReviewedArtifactContext =
  | ReviewedArtifactIssueReviewContext
  | ReviewedArtifactApprovalContext;

export type ReviewedArtifactIssueDocumentSource = {
  type: "issue_document";
  issueId: string;
  documentKey: string;
  revisionId?: string | null;
};

export type ReviewedArtifactIssueAttachmentSource = {
  type: "issue_attachment";
  issueId: string;
  attachmentId: string;
};

export type ReviewedArtifactIssueWorkProductSource = {
  type: "issue_work_product";
  issueId: string;
  workProductId: string;
};

export type ReviewedArtifactExternalUrlSource = {
  type: "external_url";
  url: string;
};

export type ReviewedArtifactApprovalPayloadSource = {
  type: "approval_payload";
  pointer: string;
};

export type ReviewedArtifactWorkspaceFileSource = {
  type: "workspace_file";
  issueId: string;
  executionWorkspaceId: string;
  runId?: string | null;
  path: string;
};

export type ReviewedArtifactUnresolvedSource = {
  type: "unresolved";
  originalType: ReviewedArtifactSourceType;
  reason: "missing_source_reference";
  missingFields: string[];
};

export type ReviewedArtifactSource =
  | ReviewedArtifactIssueDocumentSource
  | ReviewedArtifactIssueAttachmentSource
  | ReviewedArtifactIssueWorkProductSource
  | ReviewedArtifactExternalUrlSource
  | ReviewedArtifactApprovalPayloadSource
  | ReviewedArtifactWorkspaceFileSource
  | ReviewedArtifactUnresolvedSource;

export interface ReviewedArtifactItem {
  id: string;
  companyId: string;
  setId: string;
  orderIndex: number;
  sourceType: ReviewedArtifactSourceType;
  source: ReviewedArtifactSource;
  title: string | null;
  description: string | null;
  displayHint: ReviewedArtifactDisplayHint | null;
  isPrimary: boolean;
  required: boolean;
  selectedExplicitly: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewedArtifactSet {
  id: string;
  companyId: string;
  contextType: ReviewedArtifactContextType;
  contextIssueId: string | null;
  approvalId: string | null;
  selectionMode: ReviewedArtifactSelectionMode;
  title: string | null;
  description: string | null;
  supersededBySetId: string | null;
  supersededAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: ReviewedArtifactItem[];
}
