import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { executionWorkspacesApi } from "./execution-workspaces";

describe("executionWorkspacesApi.listSummaries", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("requests the lightweight summary payload", async () => {
    await executionWorkspacesApi.listSummaries("company-1", {
      projectId: "project-1",
      reuseEligible: true,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/execution-workspaces?projectId=project-1&reuseEligible=true&summary=true",
    );
  });

  it("requests and normalizes the bounded overview payload", async () => {
    mockApi.get.mockResolvedValue({
      items: [
        {
          key: "execution:workspace-1",
          kind: "execution_workspace",
          workspaceId: "workspace-1",
          workspaceName: "Workspace 1",
          projectId: "project-1",
          projectName: "Paperclip App",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: "/tmp/workspace-1",
          branchName: "PAP-1",
          lastUpdatedAt: "2026-06-25T01:00:00.000Z",
          projectWorkspaceId: null,
          executionWorkspaceId: "workspace-1",
          executionWorkspaceStatus: "active",
          serviceCount: 1,
          runningServiceCount: 1,
          primaryServiceUrl: "http://localhost:3100",
          primaryServiceUrlRunning: true,
          primaryService: {
            id: "service-1",
            serviceName: "web",
            status: "running",
            url: "http://localhost:3100",
            port: 3100,
            healthStatus: "healthy",
            updatedAt: "2026-06-25T01:01:00.000Z",
          },
          hasRuntimeConfig: true,
          linkedIssueCount: 1,
          linkedIssues: [
            {
              id: "issue-1",
              identifier: "PAP-1",
              title: "Linked task",
              status: "todo",
              priority: "medium",
              updatedAt: "2026-06-25T01:02:00.000Z",
            },
          ],
        },
      ],
      total: 1,
      limit: 25,
      offset: 10,
      hasMore: false,
      nextOffset: null,
    });

    const overview = await executionWorkspacesApi.listOverview("company-1", {
      status: ["active", "idle"],
      limit: 25,
      offset: 10,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/workspace-overview?status=active%2Cidle&limit=25&offset=10",
    );
    expect(overview.items[0]!.lastUpdatedAt).toBeInstanceOf(Date);
    expect(overview.items[0]!.primaryService?.updatedAt).toBeInstanceOf(Date);
    expect(overview.items[0]!.linkedIssues[0]!.updatedAt).toBeInstanceOf(Date);
  });
});

describe("executionWorkspacesApi.reconcile", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({});
  });

  // Regression pin (PAP-1705): the frontend path must match the reviewed, OpenAPI-documented
  // backend contract `POST /execution-workspaces/:id/reconcile-branch` (S4 / PAP-1586). A bare
  // `/reconcile` 404s both recovery-card actions. If the two sides drift, this test fails.
  it("posts forward reconcile to the /reconcile-branch route", async () => {
    await executionWorkspacesApi.reconcile("workspace-1", { mode: "forward" });

    expect(mockApi.post).toHaveBeenCalledWith("/execution-workspaces/workspace-1/reconcile-branch", {
      mode: "forward",
    });
  });

  it("posts break-glass override reconcile to the /reconcile-branch route", async () => {
    await executionWorkspacesApi.reconcile("workspace-1", { mode: "override", reason: "operator note" });

    expect(mockApi.post).toHaveBeenCalledWith("/execution-workspaces/workspace-1/reconcile-branch", {
      mode: "override",
      reason: "operator note",
    });
  });
});
