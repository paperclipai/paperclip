/**
 * Thin HTTP client for the Paperclip API.
 *
 * Used by tool handlers to call Paperclip as the agent (not the server).
 * Auth is per-call: pass the agent's authToken from AdapterExecutionContext.
 *
 * Base URL resolution order:
 *   1. explicit baseUrl arg
 *   2. PAPERCLIP_API_URL env var
 *   3. http://localhost:3100 (default Paperclip dev port)
 */

export interface PaperclipApiOptions {
  baseUrl?: string;
  authToken: string;
  /** Optional fetch impl override for tests. */
  fetchImpl?: typeof fetch;
}

export class PaperclipApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.replace(/\/+$/, "");
  const fromEnv = process.env.PAPERCLIP_API_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/+$/, "");
  return "http://localhost:3100";
}

export class PaperclipApi {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaperclipApiOptions) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    this.authToken = opts.authToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PaperclipApiError(
        `Network error calling Paperclip API: ${reason}`,
        0,
        null,
        `${method} ${path}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = null;
    if (contentType.includes("application/json")) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
    } else {
      try {
        parsed = await response.text();
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as any).error === "string"
          ? (parsed as any).error
          : null) ?? `Paperclip API ${response.status} ${response.statusText}`;
      throw new PaperclipApiError(message, response.status, parsed, `${method} ${path}`);
    }

    return parsed as T;
  }

  // ----- Issues -----

  getIssue(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}`);
  }

  updateIssue(issueId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
  }

  listCompanyIssues(companyId: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/issues${qs}`);
  }

  createIssue(companyId: string, issue: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, issue);
  }

  getHeartbeatContext(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  }

  /**
   * Acquire the issue lock for the current run. Required before any
   * write operation (add_comment, update status) on an issue, otherwise
   * Paperclip's sameRunLock check rejects with 409 "Issue run ownership
   * conflict". The run id is read by Paperclip from the JWT claims, so
   * we only need to send agentId + expectedStatuses in the body.
   */
  /**
   * Default checkout statuses: every pre-terminal status an issue can
   * be in when a run picks it up. Excludes "done" and "cancelled" since
   * a finished issue should not be re-checked-out by a new run.
   *
   * Source of truth: ISSUE_STATUSES in @paperclipai/shared/constants.
   * Keep this list in sync if Paperclip ever adds new statuses.
   */
  checkoutIssue(
    issueId: string,
    agentId: string,
    expectedStatuses: string[] = [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "blocked",
    ],
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/checkout`, {
      agentId,
      expectedStatuses,
    });
  }


  // ----- Comments -----

  listIssueComments(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/comments`);
  }

  addIssueComment(issueId: string, body: { body: string; [k: string]: unknown }): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, body);
  }

  // ----- Agents -----

  /**
   * List all agents in a company. Returns the array directly (no envelope).
   * Used by the list_agents tool so a CEO can discover teammate IDs before
   * delegating work via create_sub_issue or update_issue_status.
   */
  listCompanyAgents(companyId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
  }

  hireAgent(companyId: string, hire: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/agent-hires`, hire);
  }

  wakeAgent(agentId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/agents/${encodeURIComponent(agentId)}/wakeup`, body);
  }

  // ----- Approvals -----

  createApproval(companyId: string, approval: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/approvals`, approval);
  }
}
