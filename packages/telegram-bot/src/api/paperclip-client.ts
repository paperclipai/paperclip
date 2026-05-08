export type FetchLike = typeof fetch;

export type PaperclipClientOptions = {
  baseUrl: string;
  apiKey: string;
  companyId: string;
  fetchImpl?: FetchLike;
};

export type IssueSummary = {
  id: string;
  identifier?: string | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

export type CreateIssueInput = {
  title: string;
  description: string;
  assigneeAgentId: string;
  status?: string;
};

export type IssueComment = {
  id: string;
  body?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt?: string | null;
};

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "PaperclipApiError";
    this.status = status;
    this.body = body;
  }
}

type RequestOpts = {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Telegram chat id this request is acting on behalf of. */
  onBehalfOfChatId?: string | number | null;
};

export class PaperclipClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly companyId: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: PaperclipClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.companyId = opts.companyId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(opts: RequestOpts): Promise<T> {
    const url = new URL(opts.path.startsWith("/") ? opts.path : `/${opts.path}`, `${this.baseUrl}/`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (opts.onBehalfOfChatId !== undefined && opts.onBehalfOfChatId !== null) {
      headers["X-Telegram-Chat-Id"] = String(opts.onBehalfOfChatId);
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(url, {
      method: opts.method ?? "GET",
      headers,
      body,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const message =
        (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : null) ?? `Paperclip API ${res.status}`;
      throw new PaperclipApiError(message, res.status, parsed);
    }
    return parsed as T;
  }

  async createIssue(
    input: CreateIssueInput,
    opts: { onBehalfOfChatId?: string | number | null } = {},
  ): Promise<IssueSummary> {
    return this.request<IssueSummary>({
      method: "POST",
      path: `/api/companies/${this.companyId}/issues`,
      body: {
        title: input.title,
        description: input.description,
        assigneeAgentId: input.assigneeAgentId,
        ...(input.status ? { status: input.status } : {}),
      },
      onBehalfOfChatId: opts.onBehalfOfChatId ?? null,
    });
  }

  async findIssue(
    identifierOrId: string,
    opts: { onBehalfOfChatId?: string | number | null } = {},
  ): Promise<IssueSummary | null> {
    const trimmed = identifierOrId.trim();
    if (!trimmed) return null;
    const list = await this.request<IssueSummary[]>({
      method: "GET",
      path: `/api/companies/${this.companyId}/issues`,
      query: { q: trimmed, limit: 5 },
      onBehalfOfChatId: opts.onBehalfOfChatId ?? null,
    });
    if (!Array.isArray(list)) return null;
    const exact = list.find(
      (i) =>
        i.identifier?.toLowerCase() === trimmed.toLowerCase() || i.id === trimmed,
    );
    return exact ?? list[0] ?? null;
  }

  async getLatestIssueComment(
    issueId: string,
    opts: { onBehalfOfChatId?: string | number | null } = {},
  ): Promise<IssueComment | null> {
    const list = await this.request<IssueComment[]>({
      method: "GET",
      path: `/api/issues/${issueId}/comments`,
      query: { limit: 1, order: "desc" },
      onBehalfOfChatId: opts.onBehalfOfChatId ?? null,
    });
    if (!Array.isArray(list) || list.length === 0) return null;
    return list[0];
  }

  async postIssueComment(
    issueId: string,
    body: string,
    opts: { onBehalfOfChatId?: string | number | null } = {},
  ): Promise<IssueComment> {
    return this.request<IssueComment>({
      method: "POST",
      path: `/api/issues/${issueId}/comments`,
      body: { body },
      onBehalfOfChatId: opts.onBehalfOfChatId ?? null,
    });
  }

  async approveApproval(
    approvalId: string,
    opts: { onBehalfOfChatId?: string | number | null; comment?: string } = {},
  ): Promise<unknown> {
    return this.request({
      method: "POST",
      path: `/api/approvals/${approvalId}/approve`,
      body: opts.comment ? { comment: opts.comment } : {},
      onBehalfOfChatId: opts.onBehalfOfChatId ?? null,
    });
  }

  async rejectApproval(
    approvalId: string,
    opts: { onBehalfOfChatId?: string | number | null; comment?: string } = {},
  ): Promise<unknown> {
    return this.request({
      method: "POST",
      path: `/api/approvals/${approvalId}/reject`,
      body: opts.comment ? { comment: opts.comment } : {},
      onBehalfOfChatId: opts.onBehalfOfChatId ?? null,
    });
  }
}
