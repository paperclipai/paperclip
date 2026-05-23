import type {
  Approval,
  Issue,
  IssueWorkProduct,
  ReviewedArtifactError,
  ReviewedArtifactPreviewMode,
  ReviewedArtifactResolved,
  ReviewedArtifactsResponse,
} from "@paperclipai/shared";

type ReviewedArtifactsWireResponse = ReviewedArtifactsResponse | ReviewedArtifactResolved[];

export type ReviewedArtifactRenderKind =
  | "markdown"
  | "image"
  | "link"
  | "download_only"
  | "unsupported"
  | "missing"
  | "permission_denied"
  | "unavailable";

export interface ReviewedArtifactPanelItem extends ReviewedArtifactResolved {
  renderKind: ReviewedArtifactRenderKind;
  normalizedPrimary: boolean;
  selectionLabel: "Selected" | "Suggested";
}

export interface ReviewedArtifactsPanelModel {
  items: ReviewedArtifactPanelItem[];
  errors: ReviewedArtifactError[];
  hasExplicitSelection: boolean;
  hasSuggestedSelection: boolean;
}

const safePreviewModes = new Set<ReviewedArtifactPreviewMode>([
  "markdown",
  "image",
  "link",
  "download_only",
  "json",
  "unsupported",
]);

function isReviewedArtifactPreviewMode(value: unknown): value is ReviewedArtifactPreviewMode {
  return typeof value === "string" && safePreviewModes.has(value as ReviewedArtifactPreviewMode);
}

function normalizeReviewedArtifactsResponse(
  response: ReviewedArtifactsWireResponse | null | undefined,
): ReviewedArtifactsResponse {
  if (!response) return { artifacts: [], errors: [] };
  if (Array.isArray(response)) return { artifacts: response, errors: [] };
  return {
    ...response,
    artifacts: Array.isArray(response.artifacts) ? response.artifacts : [],
    errors: Array.isArray(response.errors) ? response.errors : [],
  };
}

function compareReviewedArtifacts(
  a: ReviewedArtifactResolved & { originalIndex: number },
  b: ReviewedArtifactResolved & { originalIndex: number },
) {
  if (a.selectedExplicitly !== b.selectedExplicitly) return a.selectedExplicitly ? -1 : 1;
  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.originalIndex - b.originalIndex;
}

function isInlineImagePreview(artifact: ReviewedArtifactResolved) {
  if (artifact.resolution.status !== "resolved") return false;
  if (artifact.preview.mode !== "image") return false;
  if (!artifact.preview.previewable || !artifact.preview.previewUrl) return false;
  return (artifact.preview.contentType ?? "").toLowerCase() !== "image/svg+xml";
}

function isInlineMarkdownPreview(artifact: ReviewedArtifactResolved) {
  if (artifact.resolution.status !== "resolved") return false;
  if (artifact.preview.mode !== "markdown") return false;
  return artifact.preview.previewable && Boolean(artifact.preview.markdownBody);
}

function resolveRenderKind(artifact: ReviewedArtifactResolved): ReviewedArtifactRenderKind {
  const status = artifact.resolution.status;
  if (status === "missing") return "missing";
  if (status === "permission_denied") return "permission_denied";
  if (status === "unavailable") return "unavailable";
  if (status === "unsupported" || status === "too_large") return "unsupported";
  if (isInlineMarkdownPreview(artifact)) return "markdown";
  if (isInlineImagePreview(artifact)) return "image";
  if (artifact.preview.mode === "link" && (artifact.preview.externalUrl || artifact.preview.previewUrl)) return "link";
  if (artifact.preview.mode === "download_only" || artifact.preview.downloadUrl) return "download_only";
  return "unsupported";
}

export function mapReviewedArtifactsResponse(
  response: ReviewedArtifactsWireResponse | null | undefined,
): ReviewedArtifactsPanelModel {
  const normalized = normalizeReviewedArtifactsResponse(response);
  const sorted = normalized.artifacts
    .map((artifact, originalIndex) => ({ ...artifact, originalIndex }))
    .sort(compareReviewedArtifacts);
  const primaryArtifact = sorted.find((artifact) => artifact.isPrimary) ?? sorted[0] ?? null;
  const items = sorted.map(({ originalIndex: _originalIndex, ...artifact }) => ({
    ...artifact,
    renderKind: resolveRenderKind(artifact),
    normalizedPrimary: Boolean(primaryArtifact && artifact.id === primaryArtifact.id),
    selectionLabel: artifact.selectedExplicitly ? "Selected" as const : "Suggested" as const,
  }));

  return {
    items,
    errors: normalized.errors ?? [],
    hasExplicitSelection: items.some((artifact) => artifact.selectedExplicitly),
    hasSuggestedSelection: items.some((artifact) => !artifact.selectedExplicitly),
  };
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function metadataNumber(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function workProductPreviewMode(workProduct: IssueWorkProduct): ReviewedArtifactPreviewMode {
  const metadata = workProduct.metadata ?? {};
  const metadataMode = metadataString(metadata, "previewMode");
  if (isReviewedArtifactPreviewMode(metadataMode)) return metadataMode;
  if (workProduct.url) return "link";
  if (metadataString(metadata, "downloadUrl")) return "download_only";
  return "unsupported";
}

function workProductToSuggestedArtifact(issue: Issue, workProduct: IssueWorkProduct, index: number): ReviewedArtifactResolved {
  const metadata = workProduct.metadata ?? {};
  const previewMode = workProductPreviewMode(workProduct);
  const previewUrl = metadataString(metadata, "previewUrl");
  const downloadUrl = metadataString(metadata, "downloadUrl");
  const contentType = metadataString(metadata, "contentType");
  const byteSize = metadataNumber(metadata, "byteSize");
  const documentKey = metadataString(metadata, "documentKey");
  const documentRevisionId = metadataString(metadata, "documentRevisionId");

  return {
    id: `suggested-work-product:${workProduct.id}`,
    sourceType: "issue_work_product",
    source: { type: "issue_work_product", issueId: issue.id, workProductId: workProduct.id },
    sourceIssue: {
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
    },
    title: workProduct.title,
    description: workProduct.summary,
    sortOrder: index,
    isPrimary: workProduct.isPrimary,
    required: false,
    selectedExplicitly: false,
    resolution: {
      status: workProduct.status === "archived" || workProduct.status === "closed" ? "unavailable" : "resolved",
      reason: null,
    },
    preview: {
      mode: previewMode,
      previewable: previewMode === "link" || Boolean(previewUrl),
      previewUrl,
      downloadUrl,
      externalUrl: workProduct.url,
      contentType,
      byteSize,
    },
    document: documentKey
      ? { key: documentKey, revisionId: documentRevisionId, revisionNumber: null }
      : null,
    snapshot: {
      provider: workProduct.provider,
      status: workProduct.status,
      healthStatus: workProduct.healthStatus,
      reviewState: workProduct.reviewState,
      createdAt: workProduct.createdAt,
      updatedAt: workProduct.updatedAt,
    },
  };
}

export function createSuggestedReviewedArtifactsResponse(issue: Issue): ReviewedArtifactsResponse {
  const workProducts = (issue.workProducts ?? [])
    .filter((workProduct) => workProduct.reviewState === "needs_board_review")
    .map((workProduct, index) => workProductToSuggestedArtifact(issue, workProduct, index));

  return {
    contextType: "issue_review",
    artifacts: workProducts,
    errors: [],
  };
}

export function hasPendingLinkedApproval(approvals: Approval[] | undefined | null) {
  return (approvals ?? []).some((approval) => (
    approval.status === "pending" || approval.status === "revision_requested"
  ));
}

export function shouldShowReviewedAssetsPanel({
  issue,
  linkedApprovals,
  response,
}: {
  issue: Issue;
  linkedApprovals?: Approval[] | null;
  response?: ReviewedArtifactsWireResponse | null;
}) {
  const model = mapReviewedArtifactsResponse(response);
  return issue.status === "in_review"
    || hasPendingLinkedApproval(linkedApprovals)
    || model.items.length > 0;
}
