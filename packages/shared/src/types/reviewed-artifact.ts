export type ReviewedArtifactContextType = "issue_review" | "approval";

export type ReviewedArtifactSourceType =
  | "issue_document"
  | "issue_attachment"
  | "issue_work_product"
  | "workspace_file"
  | "external_url"
  | "approval_payload";

export type ReviewedArtifactPreviewMode =
  | "markdown"
  | "image"
  | "link"
  | "download_only"
  | "json"
  | "unsupported";

export type ReviewedArtifactResolutionStatus =
  | "resolved"
  | "missing"
  | "permission_denied"
  | "unavailable"
  | "unsupported"
  | "too_large";

export interface ReviewedArtifactIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
}

export interface ReviewedArtifactResolution {
  status: ReviewedArtifactResolutionStatus;
  reason?: string | null;
}

export interface ReviewedArtifactPreview {
  mode: ReviewedArtifactPreviewMode;
  previewable: boolean;
  previewUrl?: string | null;
  downloadUrl?: string | null;
  externalUrl?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  markdownBody?: string | null;
}

export interface ReviewedArtifactDocumentMetadata {
  key: string;
  revisionId: string | null;
  revisionNumber: number | null;
}

export interface ReviewedArtifactResolved {
  id: string;
  sourceType: ReviewedArtifactSourceType;
  source: Record<string, unknown>;
  sourceIssue: ReviewedArtifactIssueSummary | null;
  title: string;
  description: string | null;
  sortOrder: number;
  isPrimary: boolean;
  required: boolean;
  selectedExplicitly: boolean;
  resolution: ReviewedArtifactResolution;
  preview: ReviewedArtifactPreview;
  document?: ReviewedArtifactDocumentMetadata | null;
  snapshot?: Record<string, unknown> | null;
}

export interface ReviewedArtifactError {
  source: ReviewedArtifactSourceType | "manifest";
  status?: number;
  message: string;
}

export interface ReviewedArtifactsResponse {
  contextType?: ReviewedArtifactContextType;
  artifacts: ReviewedArtifactResolved[];
  errors?: ReviewedArtifactError[];
}
