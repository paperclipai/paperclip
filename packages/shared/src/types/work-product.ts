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
