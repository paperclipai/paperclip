import type { HttpClient } from "../http.js";
import type {
  CreateWorkspaceParams,
  Page,
  PageParams,
  UpdateWorkspaceParams,
  Workspace,
} from "../types.js";

export class WorkspacesResource {
  constructor(private readonly http: HttpClient) {}

  list(params?: PageParams): Promise<Page<Workspace>> {
    return this.http.get<Page<Workspace>>("/api/v1/workspaces", {
      page: params?.page,
      pageSize: params?.pageSize,
    });
  }

  get(id: string): Promise<Workspace> {
    return this.http.get<Workspace>(`/api/v1/workspaces/${id}`);
  }

  create(params: CreateWorkspaceParams): Promise<Workspace> {
    return this.http.post<Workspace>("/api/v1/workspaces", params);
  }

  update(id: string, params: UpdateWorkspaceParams): Promise<Workspace> {
    return this.http.patch<Workspace>(`/api/v1/workspaces/${id}`, params);
  }

  delete(id: string): Promise<void> {
    return this.http.delete<void>(`/api/v1/workspaces/${id}`);
  }
}
