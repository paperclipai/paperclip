import type { HttpClient } from "../http.js";
import type { Agent, Page, PageParams } from "../types.js";

export class AgentsResource {
  constructor(private readonly http: HttpClient) {}

  list(params?: PageParams): Promise<Page<Agent>> {
    return this.http.get<Page<Agent>>("/api/v1/agents", {
      page: params?.page,
      pageSize: params?.pageSize,
    });
  }

  get(agentId: string): Promise<Agent> {
    return this.http.get<Agent>(`/api/v1/agents/${agentId}`);
  }

  listForWorkspace(
    workspaceId: string,
    params?: PageParams,
  ): Promise<Page<Agent>> {
    return this.http.get<Page<Agent>>(
      `/api/v1/workspaces/${workspaceId}/agents`,
      { page: params?.page, pageSize: params?.pageSize },
    );
  }
}
