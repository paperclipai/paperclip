import type { PluginHttpClient } from "@paperclipai/plugin-sdk";

const API = "https://api.linear.app/graphql";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  priorityLabel: string;
  state: { id: string; name: string; type: string };
  assignee: { id: string; name: string; displayName: string } | null;
  team: { id: string; name: string; key: string };
  labels: Array<{ id: string; name: string; color: string }>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  dueDate: string | null;
  estimate: number | null;
  url: string;
}

export interface LinearProject {
  id: string;
  name: string;
  state: string;
  progress: number;
  startDate: string | null;
  targetDate: string | null;
  lead: { id: string; name: string; displayName: string } | null;
  url: string;
}

export interface LinearCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  progress: number;
  scopeHistory: number[];
  completedScopeHistory: number[];
  team: { id: string; name: string; key: string };
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export class LinearClient {
  constructor(private http: PluginHttpClient, private apiKey: string) {}

  private async gql<T>(query: string): Promise<T> {
    const res = await this.http.fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Linear API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(`Linear: ${json.errors.map((e) => e.message).join("; ")}`);
    return json.data;
  }

  async verify(): Promise<{ ok: boolean; name: string | null }> {
    try {
      const d = await this.gql<{ viewer: { organization: { name: string } } }>(
        `query { viewer { organization { name } } }`,
      );
      return { ok: true, name: d.viewer.organization.name };
    } catch {
      return { ok: false, name: null };
    }
  }

  async teams(): Promise<LinearTeam[]> {
    const d = await this.gql<{ teams: { nodes: LinearTeam[] } }>(
      `query { teams(first:100) { nodes { id name key } } }`,
    );
    return d.teams.nodes;
  }

  async issues(opts: {
    teamIds?: string[];
    limit?: number;
    after?: string;
  } = {}): Promise<{ issues: LinearIssue[]; hasMore: boolean; endCursor: string | null }> {
    const filters: string[] = [];
    if (opts.teamIds?.length)
      filters.push(`team: { id: { in: [${opts.teamIds.map((id) => `"${id}"`).join(",")}] } }`);
    const f = filters.length ? `, filter: { ${filters.join(", ")} }` : "";
    const a = opts.after ? `, after: "${opts.after}"` : "";

    const d = await this.gql<{
      issues: {
        nodes: LinearIssue[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(`query { issues(first:${opts.limit ?? 250}, orderBy:updatedAt${f}${a}) {
      nodes {
        id identifier title priority priorityLabel
        state { id name type }
        assignee { id name displayName }
        team { id name key }
        labels { nodes { id name color } }
        createdAt updatedAt completedAt cancelledAt dueDate estimate url
      }
      pageInfo { hasNextPage endCursor }
    }}`);

    return {
      issues: d.issues.nodes.map((i) => ({
        ...i,
        labels: (i.labels as unknown as { nodes: LinearIssue["labels"] }).nodes ?? [],
      })),
      hasMore: d.issues.pageInfo.hasNextPage,
      endCursor: d.issues.pageInfo.endCursor,
    };
  }

  async projects(): Promise<LinearProject[]> {
    const d = await this.gql<{ projects: { nodes: LinearProject[] } }>(
      `query { projects(first:50, orderBy:updatedAt) { nodes {
        id name state progress startDate targetDate url
        lead { id name displayName }
      }}}`,
    );
    return d.projects.nodes;
  }

  async activeCycles(): Promise<LinearCycle[]> {
    const d = await this.gql<{ cycles: { nodes: LinearCycle[] } }>(
      `query { cycles(first:50, filter:{ isActive:{ eq:true } }) { nodes {
        id number name startsAt endsAt progress
        scopeHistory completedScopeHistory
        team { id name key }
      }}}`,
    );
    return d.cycles.nodes;
  }
}
