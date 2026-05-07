import type { HttpClient } from "../http.js";
import type {
  CreateTestCaseParams,
  Page,
  PageParams,
  TestCase,
  UpdateTestCaseParams,
} from "../types.js";

export class TestCasesResource {
  constructor(private readonly http: HttpClient) {}

  list(
    workspaceId: string,
    projectId: string,
    params?: PageParams,
  ): Promise<Page<TestCase>> {
    return this.http.get<Page<TestCase>>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/testcases`,
      { page: params?.page, pageSize: params?.pageSize },
    );
  }

  get(
    workspaceId: string,
    projectId: string,
    testCaseId: string,
  ): Promise<TestCase> {
    return this.http.get<TestCase>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/testcases/${testCaseId}`,
    );
  }

  create(
    workspaceId: string,
    projectId: string,
    params: CreateTestCaseParams,
  ): Promise<TestCase> {
    return this.http.post<TestCase>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/testcases`,
      params,
    );
  }

  update(
    workspaceId: string,
    projectId: string,
    testCaseId: string,
    params: UpdateTestCaseParams,
  ): Promise<TestCase> {
    return this.http.patch<TestCase>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/testcases/${testCaseId}`,
      params,
    );
  }

  delete(
    workspaceId: string,
    projectId: string,
    testCaseId: string,
  ): Promise<void> {
    return this.http.delete<void>(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/testcases/${testCaseId}`,
    );
  }
}
