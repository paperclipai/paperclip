import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
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
});
