const MOBILE_API_BASE = "/api/mobile";

export type MobileIssueStatus = "running" | "review_needed" | "blocked" | "done" | "unknown";
export type MobileHealth = "healthy" | "degraded" | "blocked";
export type MobileAgentStatus = "idle" | "running" | "error" | "blocked" | "unknown";

export interface MobileIssueRow {
  id: string;
  title: string;
  status: MobileIssueStatus;
  priority: string | null;
  assigneeName: string | null;
  updatedAt: string;
  risk: string | null;
}

export interface MobileAgentRow {
  id: string;
  name: string;
  role: string;
  status: MobileAgentStatus;
  lastActivityAt: string | null;
  usageSummary: string | null;
}

export interface MobileSummary {
  health: MobileHealth;
  counts: {
    running: number;
    reviewNeeded: number;
    blocked: number;
    done: number;
  };
  latestReport: string | null;
  telegramUrl: string | null;
}

export interface MobileChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "sent" | "delivered" | "failed";
  createdAt: string;
  replyToId: string | null;
  error: string | null;
}

export interface MobileLoginResponse {
  ok: true;
}

export interface MobileLogoutResponse {
  ok: true;
}

export interface MobileIssuesResponse {
  issues: MobileIssueRow[];
}

export interface MobileAgentsResponse {
  agents: MobileAgentRow[];
}

export interface MobileReportsResponse {
  reports: unknown[];
}

export interface MobileChatMessagesResponse {
  messages: MobileChatMessage[];
}

export interface PostMobileChatMessageResponse {
  message: MobileChatMessage;
  messages: MobileChatMessage[];
}

export interface RetryMobileChatMessageResponse {
  message: MobileChatMessage;
}

export class MobileApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "MobileApiError";
    this.status = status;
    this.body = body;
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;

  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const maybeError = body as { error?: unknown; message?: unknown };
    if (typeof maybeError.error === "string") return maybeError.error;
    if (typeof maybeError.message === "string") return maybeError.message;
  }

  return `Request failed: ${status}`;
}

export async function requestJson<T = unknown>(
  path: string,
  options: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const headers = new Headers(options.headers ?? undefined);
  const body = options.body;

  if (body !== undefined && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetchImpl(`${MOBILE_API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  const parsedBody = await parseResponseBody(response);

  if (!response.ok) {
    throw new MobileApiError(errorMessage(response.status, parsedBody), response.status, parsedBody);
  }

  return parsedBody as T;
}

export function loginMobile(token: string, fetchImpl?: typeof fetch): Promise<MobileLoginResponse> {
  return requestJson<MobileLoginResponse>(
    "/auth/login",
    { method: "POST", body: JSON.stringify({ token }) },
    fetchImpl,
  );
}

export function logoutMobile(fetchImpl?: typeof fetch): Promise<MobileLogoutResponse> {
  return requestJson<MobileLogoutResponse>(
    "/auth/logout",
    { method: "POST", body: JSON.stringify({}) },
    fetchImpl,
  );
}

export function fetchMobileSummary(fetchImpl?: typeof fetch): Promise<MobileSummary> {
  return requestJson<MobileSummary>("/summary", undefined, fetchImpl);
}

export function fetchMobileIssues(
  status?: MobileIssueStatus | string,
  fetchImpl?: typeof fetch,
): Promise<MobileIssuesResponse> {
  const path = status === undefined ? "/issues" : `/issues?${new URLSearchParams({ status }).toString()}`;
  return requestJson<MobileIssuesResponse>(path, undefined, fetchImpl);
}

export function fetchMobileAgents(fetchImpl?: typeof fetch): Promise<MobileAgentsResponse> {
  return requestJson<MobileAgentsResponse>("/agents", undefined, fetchImpl);
}

export function fetchMobileReports(fetchImpl?: typeof fetch): Promise<MobileReportsResponse> {
  return requestJson<MobileReportsResponse>("/reports", undefined, fetchImpl);
}

export function fetchMobileChatMessages(fetchImpl?: typeof fetch): Promise<MobileChatMessagesResponse> {
  return requestJson<MobileChatMessagesResponse>("/chat/messages", undefined, fetchImpl);
}

export function postMobileChatMessage(
  text: string,
  fetchImpl?: typeof fetch,
): Promise<PostMobileChatMessageResponse> {
  return requestJson<PostMobileChatMessageResponse>(
    "/chat/messages",
    { method: "POST", body: JSON.stringify({ text }) },
    fetchImpl,
  );
}

export function retryMobileChatMessage(
  id: string,
  fetchImpl?: typeof fetch,
): Promise<RetryMobileChatMessageResponse> {
  return requestJson<RetryMobileChatMessageResponse>(
    `/chat/messages/${encodeURIComponent(id)}/retry`,
    { method: "POST", body: JSON.stringify({}) },
    fetchImpl,
  );
}
