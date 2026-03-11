import type { JiraProject, JiraStatus, JiraUser, JiraIssuePreview } from "@paperclipai/shared";

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(hostUrl: string, email: string, apiToken: string) {
    this.baseUrl = hostUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jira API ${res.status}: ${body.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ displayName: string; emailAddress: string }> {
    return this.request("/rest/api/2/myself");
  }

  async listProjects(): Promise<JiraProject[]> {
    const data = await this.request<Array<{
      id: string;
      key: string;
      name: string;
      avatarUrls?: Record<string, string>;
    }>>("/rest/api/2/project");

    return data.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      avatarUrl: p.avatarUrls?.["48x48"],
    }));
  }

  async getProjectStatuses(projectKey: string): Promise<JiraStatus[]> {
    const data = await this.request<Array<{
      statuses: Array<{ id: string; name: string; statusCategory: { key: string } }>;
    }>>(`/rest/api/2/project/${encodeURIComponent(projectKey)}/statuses`);

    const seen = new Set<string>();
    const statuses: JiraStatus[] = [];
    for (const issueType of data) {
      for (const s of issueType.statuses) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          statuses.push({
            id: s.id,
            name: s.name,
            categoryKey: s.statusCategory.key,
          });
        }
      }
    }
    return statuses;
  }

  async getAssignableUsers(projectKey: string): Promise<JiraUser[]> {
    const allUsers: JiraUser[] = [];
    let startAt = 0;
    const maxResults = 1000;

    while (true) {
      const data = await this.request<Array<{
        accountId?: string;  // Cloud
        name?: string;       // Server/DC (username)
        key?: string;        // Server/DC (user key)
        displayName: string;
        emailAddress?: string;
        avatarUrls?: Record<string, string>;
      }>>(`/rest/api/2/user/assignable/search?project=${encodeURIComponent(projectKey)}&startAt=${startAt}&maxResults=${maxResults}`);

      for (const u of data) {
        // Cloud uses accountId, Server/DC uses name or key
        const id = u.accountId || u.name || u.key || "";
        if (!id) continue;
        allUsers.push({
          accountId: id,
          displayName: u.displayName,
          emailAddress: u.emailAddress,
          avatarUrl: u.avatarUrls?.["48x48"],
        });
      }

      if (data.length < maxResults) break;
      startAt += data.length;
    }

    return allUsers;
  }

  buildJql(projectKey: string, statuses: string[], assigneeAccountId?: string | null): string {
    const parts: string[] = [`project = "${projectKey}"`];
    if (statuses.length > 0) {
      // Use status IDs — more reliable than names (avoids locale/case issues)
      const statusList = statuses.join(", ");
      parts.push(`status IN (${statusList})`);
    }
    if (assigneeAccountId) {
      parts.push(`assignee = "${assigneeAccountId}"`);
    }
    return parts.join(" AND ") + " ORDER BY created DESC";
  }

  async searchIssues(jql: string, maxResults = 100): Promise<JiraIssuePreview[]> {
    // POST handles long JQL better than GET (URL length limits)
    const data = await this.request<{
      total?: number;
      issues?: Array<{
        key: string;
        fields: {
          summary?: string;
          status?: { name: string } | null;
          priority?: { name: string } | null;
          assignee?: { displayName?: string; name?: string } | null;
        };
      }>;
    }>("/rest/api/2/search", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults,
        fields: ["summary", "status", "priority", "assignee"],
      }),
    });

    return (data.issues ?? []).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary ?? "(no summary)",
      status: issue.fields.status?.name ?? "Unknown",
      priority: issue.fields.priority?.name ?? "Medium",
      assignee: issue.fields.assignee?.displayName ?? issue.fields.assignee?.name ?? null,
    }));
  }

  /** Search with description + comments + attachments included (for import) */
  async searchIssuesFull(jql: string, maxResults = 100): Promise<JiraIssuePreview[]> {
    const data = await this.request<{
      total?: number;
      issues?: Array<{
        key: string;
        fields: {
          summary?: string;
          description?: string | null;
          status?: { name: string } | null;
          priority?: { name: string } | null;
          assignee?: { displayName?: string; name?: string } | null;
          comment?: {
            comments?: Array<{
              author?: { displayName?: string; name?: string };
              body?: string;
              created?: string;
            }>;
          };
          attachment?: Array<{
            id: string;
            filename: string;
            mimeType: string;
            size: number;
            content: string; // download URL
          }>;
        };
      }>;
    }>("/rest/api/2/search", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults,
        fields: ["summary", "description", "status", "priority", "assignee", "comment", "attachment"],
      }),
    });

    return (data.issues ?? []).map((issue) => {
      const comments = (issue.fields.comment?.comments ?? [])
        .filter((c) => c.body)
        .map((c) => {
          const author = c.author?.displayName ?? c.author?.name ?? "Unknown";
          const date = c.created ? new Date(c.created).toISOString().slice(0, 10) : "";
          return `**${author}** (${date}):\n${c.body}`;
        });

      const attachments = (issue.fields.attachment ?? []).map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        contentUrl: a.content,
      }));

      return {
        key: issue.key,
        summary: issue.fields.summary ?? "(no summary)",
        status: issue.fields.status?.name ?? "Unknown",
        priority: issue.fields.priority?.name ?? "Medium",
        assignee: issue.fields.assignee?.displayName ?? issue.fields.assignee?.name ?? null,
        description: issue.fields.description ?? null,
        comments,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    });
  }

  /** Download an attachment binary from Jira */
  async downloadAttachment(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: "*/*",
      },
    });

    if (!res.ok) {
      throw new Error(`Jira attachment download ${res.status}: ${url}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }
}
