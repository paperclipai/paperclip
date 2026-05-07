import type { HttpClient } from "../http.js";
import type {
  CancelExecutionParams,
  CreateExecutionParams,
  Execution,
  Page,
  PageParams,
} from "../types.js";

export class ExecutionsResource {
  constructor(private readonly http: HttpClient) {}

  list(workspaceId: string, params?: PageParams): Promise<Page<Execution>> {
    return this.http.get<Page<Execution>>(
      `/api/v1/workspaces/${workspaceId}/executions`,
      { page: params?.page, pageSize: params?.pageSize },
    );
  }

  get(workspaceId: string, executionId: string): Promise<Execution> {
    return this.http.get<Execution>(
      `/api/v1/workspaces/${workspaceId}/executions/${executionId}`,
    );
  }

  create(
    workspaceId: string,
    params: CreateExecutionParams,
  ): Promise<Execution> {
    return this.http.post<Execution>(
      `/api/v1/workspaces/${workspaceId}/executions`,
      params,
    );
  }

  cancel(
    workspaceId: string,
    executionId: string,
    params?: CancelExecutionParams,
  ): Promise<Execution> {
    return this.http.post<Execution>(
      `/api/v1/workspaces/${workspaceId}/executions/${executionId}/cancel`,
      params,
    );
  }

  delete(workspaceId: string, executionId: string): Promise<void> {
    return this.http.delete<void>(
      `/api/v1/workspaces/${workspaceId}/executions/${executionId}`,
    );
  }
}
