const DEFAULT_BASE_URL = "http://localhost:3100";

export class PaperclipApiError extends Error {
  status: number;
  body: unknown;
  endpoint: string;

  constructor(status: number, body: unknown, endpoint: string) {
    super(`Paperclip API error ${status} at ${endpoint}`);
    this.name = "PaperclipApiError";
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export class PaperclipApi {
  private baseUrl: string;
  private authToken: string;

  constructor({ authToken }: { authToken: string }) {
    this.baseUrl = process.env.PAPERCLIP_API_URL ?? DEFAULT_BASE_URL;
    this.authToken = authToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const responseBody = await res.json().catch(() => null);
    if (!res.ok) {
      throw new PaperclipApiError(res.status, responseBody, `${method} ${path}`);
    }
    return responseBody as T;
  }

  // Issues
  getIssue(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${issueId}`);
  }

  updateIssue(issueId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/issues/${issueId}`, patch);
  }

  checkoutIssue(issueId: string, agentId: string, expectedStatuses: string[]): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${issueId}/checkout`, {
      agentId,
      expectedStatuses,
    });
  }

  listCompanyIssues(companyId: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const params = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : "";
    return this.request("GET", `/api/companies/${companyId}/issues${params}`);
  }

  createIssue(companyId: string, issue: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${companyId}/issues`, issue);
  }

  // Comments
  listIssueComments(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${issueId}/comments`);
  }

  addIssueComment(issueId: string, body: { body: string }): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${issueId}/comments`, body);
  }

  // Agents
  listCompanyAgents(companyId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/companies/${companyId}/agents`);
  }

  hireAgent(companyId: string, hire: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${companyId}/agents`, hire);
  }

  // Approvals
  createApproval(companyId: string, approval: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${companyId}/approvals`, approval);
  }
}
