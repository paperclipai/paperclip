import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({});
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { parentId: "issue-parent-1", limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25",
    );
  });

  it("passes descendantOf through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { descendantOf: "issue-root-1", includeBlockedBy: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?descendantOf=issue-root-1&includeBlockedBy=true&limit=25",
    );
  });

  it("passes generic workspaceId filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { workspaceId: "workspace-1", limit: 1000 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?workspaceId=workspace-1&limit=1000",
    );
  });

  it("passes pagination offsets through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { limit: 500, offset: 1500 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&offset=1500",
    );
  });

  it("passes issue list sort options through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      limit: 500,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&sortField=updated&sortDir=desc",
    );
  });

  it("requests the compact issue list view explicitly", async () => {
    await issuesApi.listCompact("company-1", {
      touchedByUserId: "me",
      includeLiveDescendantSummary: true,
      limit: 100,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?touchedByUserId=me&includeLiveDescendantSummary=true&limit=100&sortField=updated&sortDir=desc&view=compact",
    );
  });

  it("passes plan document filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { hasPlanDocument: false, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?hasPlanDocument=false&limit=25",
    );
  });

  it("passes live descendant summary opt-in through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { includeLiveDescendantSummary: true, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?includeLiveDescendantSummary=true&limit=25",
    );
  });

  it("posts recovery action resolution to the source issue endpoint", async () => {
    await issuesApi.resolveRecoveryAction("issue-1", {
      actionId: "00000000-0000-0000-0000-0000000000aa",
      outcome: "restored",
      sourceIssueStatus: "done",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      "/issues/issue-1/recovery-actions/resolve",
      {
        actionId: "00000000-0000-0000-0000-0000000000aa",
        outcome: "restored",
        sourceIssueStatus: "done",
      },
    );
  });
});
