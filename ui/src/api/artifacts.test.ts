import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { artifactsApi, type CompanyArtifact } from "./artifacts";

function sampleArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "wp-1",
    source: "work_product",
    mediaKind: "video",
    title: "Primary cut",
    previewText: null,
    contentType: "video/mp4",
    contentPath: "/files/wp-1.mp4",
    openPath: "/files/wp-1.mp4",
    downloadPath: "/files/wp-1.mp4?download=1",
    issue: { id: "issue-1", identifier: "PAP-10205", title: "Demo reel" },
    project: { id: "proj-1", name: "Paperclip App" },
    createdByAgent: { id: "agent-1", name: "ClaudeCoder" },
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/issues/PAP-10205#work-product-wp-1",
    ...overrides,
  };
}

describe("artifactsApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ artifacts: [], nextCursor: null });
  });

  it("calls the company-scoped artifacts endpoint with no params", async () => {
    await artifactsApi.list("company-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/artifacts");
  });

  it("omits the kind param when filtering by all", async () => {
    await artifactsApi.list("company-1", { kind: "all" });
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/artifacts");
  });

  it("serializes kind, project, search, and pagination params", async () => {
    await artifactsApi.list("company-1", {
      kind: "video",
      projectId: "proj-1",
      q: "demo reel",
      limit: 24,
      cursor: "abc",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/artifacts?kind=video&projectId=proj-1&q=demo+reel&limit=24&cursor=abc",
    );
  });

  it("omits groupBy when grouping is none", async () => {
    await artifactsApi.list("company-1", { groupBy: "none" });
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/artifacts");
  });

  it("serializes groupBy and the selected stack issue", async () => {
    await artifactsApi.list("company-1", {
      groupBy: "parent_task",
      groupIssueId: "issue-9",
      kind: "image",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/artifacts?kind=image&groupBy=parent_task&groupIssueId=issue-9",
    );
  });

  it("preserves groups and selectedGroup from the envelope", async () => {
    const artifact = sampleArtifact();
    const group = {
      id: "task:issue-1",
      groupBy: "task" as const,
      issue: artifact.issue,
      title: "Demo reel",
      count: 3,
      mediaKinds: ["video" as const],
      previewArtifacts: [artifact],
      updatedAt: "2026-06-01T00:00:00.000Z",
      href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-1",
    };
    mockApi.get.mockResolvedValue({ artifacts: [], groups: [group], nextCursor: "next" });
    const result = await artifactsApi.list("company-1", { groupBy: "task" });
    expect(result.groups).toEqual([group]);
    expect(result.nextCursor).toBe("next");
  });

  it("returns the envelope shape from the backend", async () => {
    const artifact = sampleArtifact();
    mockApi.get.mockResolvedValue({ artifacts: [artifact], nextCursor: "next" });
    const result = await artifactsApi.list("company-1");
    expect(result).toEqual({ artifacts: [artifact], nextCursor: "next" });
  });

  it("normalizes a bare array response into the envelope shape", async () => {
    const artifact = sampleArtifact();
    mockApi.get.mockResolvedValue([artifact]);
    const result = await artifactsApi.list("company-1");
    expect(result).toEqual({ artifacts: [artifact], nextCursor: null });
  });
});
