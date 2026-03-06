import type { PaperclipMobileConfig } from "./config";

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";
export type IssuePriority = "critical" | "high" | "medium" | "low";

interface PaperclipIssueResponse {
  id: string;
  identifier?: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  updatedAt: string;
}

interface PaperclipIssueDetailResponse extends PaperclipIssueResponse {
  description?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
  executionAgentNameKey?: string | null;
  executionLockedAt?: string | null;
  wakeReason?: string | null;
  wakeCommentId?: string | null;
  wakeTaskId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface PaperclipIssueCommentResponse {
  id: string;
  body: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt: string;
}

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  updatedAt: string;
}

export interface IssueDetail extends IssueSummary {
  description: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  wakeTaskId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface IssueComment {
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

interface AuthenticatedRequestParams {
  apiKey: string;
  config: PaperclipMobileConfig;
  runId?: string;
}

interface FetchIssueParams extends AuthenticatedRequestParams {}

interface FetchIssueDetailParams extends AuthenticatedRequestParams {
  issueId: string;
}

interface AddIssueCommentParams extends AuthenticatedRequestParams {
  issueId: string;
  body: string;
}

interface CheckoutIssueParams extends AuthenticatedRequestParams {
  issueId: string;
}

interface UpdateIssueStatusParams extends AuthenticatedRequestParams {
  issueId: string;
  status: IssueStatus;
}

const STATUS_FILTER = "todo,in_progress,blocked";
const PRIORITY_WEIGHT: Record<IssuePriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface ApiResponseBodyError {
  error?: string;
  details?: {
    code?: string;
    reason?: string;
  };
}

interface PaperclipApiErrorOptions {
  status?: number;
  details?: string;
  code?: string;
  isNetworkError?: boolean;
}

export class PaperclipApiError extends Error {
  readonly status: number | null;
  readonly details: string | null;
  readonly code: string | null;
  readonly isNetworkError: boolean;

  constructor(message: string, options: PaperclipApiErrorOptions = {}) {
    super(message);
    this.name = "PaperclipApiError";
    this.status = options.status ?? null;
    this.details = options.details ?? null;
    this.code = options.code ?? null;
    this.isNetworkError = options.isNetworkError ?? false;
  }
}

function toIssueSummary(issue: PaperclipIssueResponse): IssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier ?? issue.id.slice(0, 8),
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    updatedAt: issue.updatedAt,
  };
}

function toIssueDetail(issue: PaperclipIssueDetailResponse): IssueDetail {
  const summary = toIssueSummary(issue);
  return {
    ...summary,
    description: issue.description ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    assigneeUserId: issue.assigneeUserId ?? null,
    projectId: issue.projectId ?? null,
    goalId: issue.goalId ?? null,
    parentId: issue.parentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
    executionAgentNameKey: issue.executionAgentNameKey ?? null,
    executionLockedAt: issue.executionLockedAt ?? null,
    wakeReason: issue.wakeReason ?? null,
    wakeCommentId: issue.wakeCommentId ?? null,
    wakeTaskId: issue.wakeTaskId ?? null,
    createdAt: issue.createdAt,
    startedAt: issue.startedAt ?? null,
    completedAt: issue.completedAt ?? null,
  };
}

function toIssueComment(comment: PaperclipIssueCommentResponse): IssueComment {
  return {
    id: comment.id,
    body: comment.body,
    authorAgentId: comment.authorAgentId ?? null,
    authorUserId: comment.authorUserId ?? null,
    createdAt: comment.createdAt,
  };
}

async function parseErrorPayload(response: Response): Promise<{
  detailsText: string;
  errorCode: string | null;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  const rawBody = await response.text();
  if (!rawBody) {
    return { detailsText: "", errorCode: null };
  }

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody) as ApiResponseBodyError;
      const detailParts = [parsed.error, parsed.details?.reason].filter(
        (value): value is string => Boolean(value),
      );
      return {
        detailsText: detailParts.join(" -- ").slice(0, 240),
        errorCode: parsed.details?.code ?? null,
      };
    } catch {
      return {
        detailsText: rawBody.slice(0, 240),
        errorCode: null,
      };
    }
  }

  return {
    detailsText: rawBody.slice(0, 240),
    errorCode: null,
  };
}

function requireMutationRunId(runId?: string): string {
  const value = runId?.trim() ?? "";
  if (!value) {
    throw new PaperclipApiError("Missing run ID for mutation request.");
  }
  return value;
}

interface RequestJsonParams extends AuthenticatedRequestParams {
  endpoint: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
}

async function requestJson<TResponse>(
  params: RequestJsonParams,
): Promise<TResponse> {
  const { endpoint, apiKey, runId, method = "GET", body } = params;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-Paperclip-Run-Id"] = requireMutationRunId(runId);
  }

  try {
    const response = await fetch(endpoint, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const { detailsText, errorCode } = await parseErrorPayload(response);
      throw new PaperclipApiError(
        `Paperclip API request failed (${response.status} ${response.statusText})${
          detailsText ? `: ${detailsText}` : ""
        }`,
        {
          status: response.status,
          details: detailsText || undefined,
          code: errorCode || undefined,
          isNetworkError: false,
        },
      );
    }

    return (await response.json()) as TResponse;
  } catch (error) {
    if (error instanceof PaperclipApiError) {
      throw error;
    }

    throw new PaperclipApiError(
      "Paperclip API network request failed. Check connectivity and API URL.",
      {
        isNetworkError: true,
      },
    );
  }
}

export function isConflictError(error: unknown): boolean {
  return error instanceof PaperclipApiError && error.status === 409;
}

export function isRetriableOfflineError(error: unknown): boolean {
  if (!(error instanceof PaperclipApiError)) {
    return false;
  }

  if (error.isNetworkError) {
    return true;
  }

  if (error.status == null) {
    return false;
  }

  return error.status >= 500;
}

export async function fetchInboxIssues({
  apiKey,
  config,
}: FetchIssueParams): Promise<IssueSummary[]> {
  if (config.missing.length > 0) {
    throw new PaperclipApiError(`Missing app config: ${config.missing.join(", ")}`);
  }

  const query = new URLSearchParams({
    assigneeAgentId: config.agentId,
    status: STATUS_FILTER,
  });
  const endpoint = `${config.apiUrl}/api/companies/${encodeURIComponent(
    config.companyId,
  )}/issues?${query.toString()}`;

  const data = await requestJson<PaperclipIssueResponse[]>({
    endpoint,
    apiKey,
    config,
  });
  if (!Array.isArray(data)) {
    throw new PaperclipApiError("Unexpected API payload: expected issue array.");
  }

  return data
    .map(toIssueSummary)
    .sort(
      (a, b) =>
        PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}

export async function fetchIssueDetail({
  issueId,
  apiKey,
  config,
}: FetchIssueDetailParams): Promise<IssueDetail> {
  const endpoint = `${config.apiUrl}/api/issues/${encodeURIComponent(issueId)}`;

  const data = await requestJson<PaperclipIssueDetailResponse>({
    endpoint,
    apiKey,
    config,
  });

  return toIssueDetail(data);
}

export async function fetchIssueComments({
  issueId,
  apiKey,
  config,
}: FetchIssueDetailParams): Promise<IssueComment[]> {
  const endpoint = `${config.apiUrl}/api/issues/${encodeURIComponent(issueId)}/comments`;

  const data = await requestJson<PaperclipIssueCommentResponse[]>({
    endpoint,
    apiKey,
    config,
  });

  if (!Array.isArray(data)) {
    throw new PaperclipApiError("Unexpected API payload: expected comment array.");
  }

  return data.map(toIssueComment);
}

export async function checkoutIssue({
  issueId,
  apiKey,
  config,
  runId,
}: CheckoutIssueParams): Promise<void> {
  const endpoint = `${config.apiUrl}/api/issues/${encodeURIComponent(issueId)}/checkout`;

  await requestJson({
    endpoint,
    apiKey,
    config,
    runId,
    method: "POST",
    body: {
      agentId: config.agentId,
      expectedStatuses: ["todo", "backlog", "blocked", "in_progress"],
    },
  });
}

export async function addIssueComment({
  issueId,
  apiKey,
  config,
  runId,
  body,
}: AddIssueCommentParams): Promise<void> {
  const endpoint = `${config.apiUrl}/api/issues/${encodeURIComponent(issueId)}/comments`;

  await requestJson({
    endpoint,
    apiKey,
    config,
    runId,
    method: "POST",
    body: {
      body,
    },
  });
}

export async function updateIssueStatus({
  issueId,
  apiKey,
  config,
  runId,
  status,
}: UpdateIssueStatusParams): Promise<void> {
  const endpoint = `${config.apiUrl}/api/issues/${encodeURIComponent(issueId)}`;

  await requestJson({
    endpoint,
    apiKey,
    config,
    runId,
    method: "PATCH",
    body: {
      status,
    },
  });
}

export async function pingPaperclipHealth(config: PaperclipMobileConfig): Promise<boolean> {
  const endpoint = `${config.apiUrl}/api/health`;

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
