export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
  };
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  transitions: JiraTransition[];
}

export interface JiraClientConfig {
  baseUrl: string;
  userEmail: string;
  apiToken: string;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: JiraClientConfig, fetchFn?: typeof fetch) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${config.userEmail}:${config.apiToken}`).toString("base64")}`;
    this.fetchFn = fetchFn ?? fetch;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const response = await this.fetchFn(url, {
      ...options,
      headers: {
        "Authorization": this.authHeader,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Jira API error ${response.status} ${response.statusText}: ${body}`);
    }

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return response.json() as Promise<T>;
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const data = await this.request<{ transitions: JiraTransition[] }>(
      `/issue/${issueKey}/transitions`,
    );
    return data.transitions;
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    const [issueData, transitions] = await Promise.all([
      this.request<{
        key: string;
        fields: {
          summary: string;
          status: { name: string };
          assignee: { displayName: string } | null;
        };
      }>(`/issue/${issueKey}`),
      this.getTransitions(issueKey),
    ]);

    return {
      key: issueData.key,
      summary: issueData.fields.summary,
      status: issueData.fields.status.name,
      assignee: issueData.fields.assignee?.displayName ?? null,
      transitions,
    };
  }

  async transition(issueKey: string, transitionId: string): Promise<void> {
    await this.request(`/issue/${issueKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }

  async assignIssue(issueKey: string, accountId: string | null): Promise<void> {
    await this.request(`/issue/${issueKey}/assignee`, {
      method: "PUT",
      body: JSON.stringify({ accountId }),
    });
  }
}
