export type IssueWorkProductType =
  | "preview_url"
  | "runtime_service"
  | "pull_request"
  | "branch"
  | "commit"
  | "artifact"
  | "document";

export type IssueWorkProductProvider =
  | "paperclip"
  | "github"
  | "vercel"
  | "s3"
  | "custom";

export type IssueWorkProductStatus =
  | "active"
  | "ready_for_review"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed"
  | "failed"
  | "archived"
  | "draft";

export type IssueWorkProductReviewState =
  | "none"
  | "needs_board_review"
  | "approved"
  | "changes_requested";

export interface IssueArtifactWorkProductMetadata {
  attachmentId: string;
  contentPath: string;
  sourcePath: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
}

export interface IssueWorkProduct {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string;
  executionWorkspaceId: string | null;
  runtimeServiceId: string | null;
  type: IssueWorkProductType;
  provider: IssueWorkProductProvider | string;
  externalId: string | null;
  title: string;
  url: string | null;
  status: IssueWorkProductStatus | string;
  reviewState: IssueWorkProductReviewState;
  isPrimary: boolean;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isIssueArtifactWorkProductMetadata(
  value: unknown,
): value is IssueArtifactWorkProductMetadata {
  const metadata = asRecord(value);
  if (!metadata) return false;

  const attachmentId = readString(metadata.attachmentId);
  const contentPath = readString(metadata.contentPath);
  const sourcePath = readString(metadata.sourcePath);
  const contentType = readString(metadata.contentType);
  const byteSize = readNumber(metadata.byteSize);

  const originalFilename = metadata.originalFilename;
  if (originalFilename !== undefined && originalFilename !== null && typeof originalFilename !== "string") {
    return false;
  }

  return Boolean(
    attachmentId
      && contentPath
      && sourcePath
      && contentType
      && byteSize !== null
      && Number.isInteger(byteSize)
      && byteSize > 0,
  );
}

function isStoredIssueArtifactWorkProductMetadata(
  value: unknown,
): value is IssueArtifactWorkProductMetadata {
  const metadata = asRecord(value);
  if (!metadata) return false;

  const attachmentId = readString(metadata.attachmentId);
  const contentPath = readString(metadata.contentPath);
  const sourcePath = readString(metadata.sourcePath);
  const contentType = readString(metadata.contentType);
  const byteSize = readNumber(metadata.byteSize);

  const originalFilename = metadata.originalFilename;
  if (originalFilename !== undefined && originalFilename !== null && typeof originalFilename !== "string") {
    return false;
  }

  return Boolean(
    attachmentId
      && contentPath
      && sourcePath
      && contentType
      && byteSize !== null
      && Number.isInteger(byteSize)
      && byteSize >= 0,
  );
}

export function parseIssueArtifactWorkProductMetadata(
  product: Pick<IssueWorkProduct, "type" | "metadata">,
): IssueArtifactWorkProductMetadata | null {
  if (product.type !== "artifact") return null;
  const metadata = asRecord(product.metadata);
  if (!isStoredIssueArtifactWorkProductMetadata(metadata)) return null;

  const originalFilename =
    typeof metadata.originalFilename === "string" ? metadata.originalFilename : null;

  return { ...(metadata as IssueArtifactWorkProductMetadata), originalFilename };
}
