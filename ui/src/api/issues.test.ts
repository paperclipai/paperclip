import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { parentId: "issue-parent-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25",
    );
  });

  it("passes descendantOf through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { descendantOf: "issue-root-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?descendantOf=issue-root-1&limit=25",
    );
  });

  it("passes generic workspaceId filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { workspaceId: "workspace-1", limit: 1000 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?workspaceId=workspace-1&limit=1000",
    );
  });
});
