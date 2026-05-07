import type { HttpClient } from "../http.js";
import type {
  CreateProjectParams,
  Page,
  PageParams,
  Project,
  UpdateProjectParams,
} from "../types.js";

export class ProjectsResource {
  constructor(private readonly http: HttpClient) {}

  list(workspaceId: string, params?: PageParams): Promise<Page<Project>> {
    return this.http.get<Page<Project>>(
      `/api/v1/workspaces/${workspaceId}/projects`,
      { page: params?.page, pageSize: params?.pageSize },
    );
  }

  get(workspaceId: string, projectId: string): Promise<Project> {
    return this.http.get<Project>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}`,
    );
  }

  create(workspaceId: string, params: CreateProjectParams): Promise<Project> {
    return this.http.post<Project>(
      `/api/v1/workspaces/${workspaceId}/projects`,
      params,
    );
  }

  update(
    workspaceId: string,
    projectId: string,
    params: UpdateProjectParams,
  ): Promise<Project> {
    return this.http.patch<Project>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}`,
      params,
    );
  }

  delete(workspaceId: string, projectId: string): Promise<void> {
    return this.http.delete<void>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}`,
    );
  }
}
