/**
 * Bridge-side Paperclip REST client. Mirrors v2/paperclip-shim.ts client
 * but for outbound (bridge → Paperclip) operations: issue creation,
 * agent wakeup, comment polling.
 *
 * Auth: localhost on local_trusted deployment mode requires no token.
 * Optional bearer token via PAPERCLIP_API_KEY env.
 */

export type IssueCreate = {
  title: string;
  description?: string;
  status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  priority?: "low" | "medium" | "high" | "urgent";
  assigneeAgentId?: string;
  parentId?: string;
  originKind?: "manual" | "interactive";
  originFingerprint?: string;
};

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  updatedAt: string;
  originFingerprint?: string | null;
};

export type Comment = {
  id: string;
  issueId: string;
  body: string;
  createdAt: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
};

export type Agent = {
  id: string;
  name: string;
  adapterType?: string;
};

export type Routine = {
  id: string;
  title: string;
  assigneeAgentId?: string | null;
  triggers?: Array<{ id: string; kind: string; cronExpression?: string }>;
};

export type IssueUpdate = {
  status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  assigneeAgentId?: string | null;
  comment?: string;
  reopen?: boolean;
  resume?: boolean;
  interrupt?: boolean;
};

export class PaperclipBridgeClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey?: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`Paperclip ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
    }
    // Some endpoints return 204 / empty body
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  async createIssue(companyId: string, body: IssueCreate): Promise<Issue> {
    return this.req<Issue>("POST", `/api/companies/${companyId}/issues`, body);
  }

  async wakeAgent(agentId: string, opts: { reason?: string; source?: string } = {}): Promise<void> {
    await this.req<void>("POST", `/api/agents/${agentId}/wakeup`, {
      reason: opts.reason ?? "telegram-inbound",
      source: opts.source ?? "automation",
    });
  }

  /**
   * Fetch a single issue by ID. Used to inspect originKind / labels for
   * outbound routing decisions (e.g., routine-spawned issues should fall
   * back to the workspace's default Telegram chat).
   */
  async getIssue(issueId: string): Promise<{ id: string; companyId: string; originKind?: string; labels?: string[] } | null> {
    return this.req<any>("GET", `/api/issues/${issueId}`);
  }

  /** Find the most recent open (non-done, non-cancelled) issue assigned to an agent
   *  in a company, created within the last N minutes. Returns null if none found. */
  async findRecentOpenIssue(companyId: string, agentId: string, withinMinutes = 30): Promise<Issue | null> {
    const issues = await this.req<Issue[]>(
      "GET",
      `/api/companies/${companyId}/issues?status=todo,in_progress,in_review,blocked,backlog&assigneeAgentId=${agentId}&limit=20`,
    );
    if (!issues || !Array.isArray(issues) || issues.length === 0) return null;
    const cutoff = Date.now() - withinMinutes * 60_000;
    // Sort by updatedAt descending, pick the most recent one created within window
    const sorted = issues
      .filter((i) => new Date(i.updatedAt).getTime() > cutoff)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sorted[0] ?? null;
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    return this.req<{ id: string }>("POST", `/api/issues/${issueId}/comments`, { body });
  }

  /**
   * Poll for new comments since `since` (ISO timestamp). Bridge maintains a
   * cursor per company; advances after each successful round-trip.
   */
  async getNewComments(
    companyId: string,
    since: string,
  ): Promise<Comment[]> {
    // Paperclip exposes per-issue comments at /api/issues/:id/comments. To get
    // new comments across a company, we'd ideally have a /api/companies/:id/comments
    // endpoint. For Phase 1A we walk the company's recently-updated issues and
    // fetch their comments. Optimization for Phase 1A-3 follow-up.
    const allIssues = await this.req<Issue[]>(
      "GET",
      `/api/companies/${companyId}/issues?updatedSince=${encodeURIComponent(since)}&limit=50`,
    );
    // Paperclip's updatedSince param doesn't filter server-side — filter client-side.
    const issues = (allIssues ?? []).filter((i) => i.updatedAt >= since);
    const all: Comment[] = [];
    for (const issue of issues) {
      const comments = await this.req<Comment[] | { comments?: Comment[] }>(
        "GET",
        `/api/issues/${issue.id}/comments?since=${encodeURIComponent(since)}&limit=20`,
      );
      const list = Array.isArray(comments) ? comments : comments.comments ?? [];
      for (const c of list) all.push({ ...c, issueId: issue.id });
    }
    return all;
  }

  /**
   * List all issues for a company. Used by /status and /tasks commands.
   */
  async listIssues(companyId: string): Promise<Issue[]> {
    const res = await this.req<Issue[]>(
      "GET",
      `/api/companies/${companyId}/issues?limit=100`,
    );
    return res ?? [];
  }

  /**
   * Update an issue (status, comment, reopen, etc.).
   */
  async updateIssue(issueId: string, patch: IssueUpdate): Promise<Issue> {
    return this.req<Issue>("PATCH", `/api/issues/${issueId}`, patch);
  }

  /**
   * Resolve an issue identifier (like "KARL-42") to a UUID.
   * Falls back to trying the input as a raw UUID.
   */
  async resolveIssueId(identifier: string): Promise<string | null> {
    // Try as UUID first (8-4-4-4-12 hex pattern)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
      try {
        await this.getIssue(identifier);
        return identifier;
      } catch {
        return null;
      }
    }
    // Try fetching by identifier — Paperclip GET /issues/:id accepts identifiers
    try {
      const issue = await this.req<Issue>("GET", `/api/issues/${encodeURIComponent(identifier)}`);
      return issue?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * List agents for a company. Used by /agents command.
   */
  async listAgents(companyId: string): Promise<Agent[]> {
    const res = await this.req<Agent[]>(
      "GET",
      `/api/companies/${companyId}/agents`,
    );
    return res ?? [];
  }

  /**
   * List routines for a company. Used by /crons command.
   * Fetches triggers for each routine to show cron expressions.
   */
  async listRoutines(companyId: string): Promise<Routine[]> {
    const res = await this.req<Routine[]>(
      "GET",
      `/api/companies/${companyId}/routines`,
    );
    const routines = res ?? [];
    // Fetch triggers for each routine that might have schedule triggers
    for (const r of routines) {
      try {
        const detail = await this.req<Routine>(`GET`, `/api/routines/${r.id}`);
        if (detail?.triggers) r.triggers = detail.triggers;
      } catch {
        /* best-effort */
      }
    }
    return routines;
  }
}
