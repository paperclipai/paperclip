import type { FetchLike } from "../api/paperclip-client.js";
import type {
  AgentRef,
  ApprovalRef,
  CommentRef,
  InteractionRef,
  IssueRef,
} from "./types.js";

export type NotifierApiOptions = {
  baseUrl: string;
  apiKey: string;
  companyId: string;
  fetchImpl?: FetchLike;
};

/**
 * Minimal read-only Paperclip API surface that the outbound notifier needs.
 * Kept separate from the inbound `PaperclipClient` so notifier-specific
 * query-string contracts (THE-346 server-side filters) stay in one place.
 */
export class NotifierApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly companyId: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: NotifierApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.companyId = opts.companyId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Paperclip ${res.status} on ${path}: ${text.slice(0, 200)}`);
    }
    if (!text) return [] as unknown as T;
    return JSON.parse(text) as T;
  }

  /** Issues touched by `userId` (created/assigned/commented), in `in_review`. */
  async listInReviewIssuesForUser(userId: string, limit = 50): Promise<IssueRef[]> {
    const list = await this.get<IssueRef[] | { items?: IssueRef[] }>(
      `/api/companies/${this.companyId}/issues`,
      { touchedByUserId: userId, status: "in_review", limit },
    );
    return Array.isArray(list) ? list : list.items ?? [];
  }

  /** Issues blocked, scoped to `userId` (server-side filter). */
  async listBlockedIssuesForUser(userId: string, limit = 50): Promise<IssueRef[]> {
    const list = await this.get<IssueRef[] | { items?: IssueRef[] }>(
      `/api/companies/${this.companyId}/issues`,
      { touchedByUserId: userId, status: "blocked", limit },
    );
    return Array.isArray(list) ? list : list.items ?? [];
  }

  /**
   * Issues finished by anyone but created by `userId` — the THE-346 contract
   * uses `createdByUserId` for "issues, которые создал/попросил Динар".
   */
  async listDoneIssuesCreatedBy(userId: string, limit = 50): Promise<IssueRef[]> {
    const list = await this.get<IssueRef[] | { items?: IssueRef[] }>(
      `/api/companies/${this.companyId}/issues`,
      { createdByUserId: userId, status: "done", limit },
    );
    return Array.isArray(list) ? list : list.items ?? [];
  }

  /** Pending approvals — no per-user filter (any board member decides). */
  async listPendingApprovals(limit = 50): Promise<ApprovalRef[]> {
    const list = await this.get<ApprovalRef[] | { items?: ApprovalRef[] }>(
      `/api/companies/${this.companyId}/approvals`,
      { status: "pending", limit },
    );
    return Array.isArray(list) ? list : list.items ?? [];
  }

  async listInteractionsForIssue(issueId: string): Promise<InteractionRef[]> {
    const list = await this.get<InteractionRef[] | { items?: InteractionRef[] }>(
      `/api/issues/${issueId}/interactions`,
      {},
    );
    return Array.isArray(list) ? list : list.items ?? [];
  }

  async getAgent(agentId: string): Promise<AgentRef | null> {
    try {
      const a = await this.get<AgentRef>(`/api/agents/${agentId}`, {});
      return a;
    } catch {
      return null;
    }
  }

  async getLatestComment(issueId: string): Promise<CommentRef | null> {
    const list = await this.get<CommentRef[] | { items?: CommentRef[] }>(
      `/api/issues/${issueId}/comments`,
      { order: "desc", limit: 1 },
    );
    const arr = Array.isArray(list) ? list : list.items ?? [];
    return arr[0] ?? null;
  }
}
