import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  api: {
    get: mockGet,
    post: vi.fn(),
    postForm: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue([]);
  });

  it("excludes blocked recovery sources with open successors by default", async () => {
    await issuesApi.list("company-1");

    expect(mockGet).toHaveBeenCalledWith(
      "/companies/company-1/issues?excludeRecoverySourcesWithOpenSuccessors=true",
    );
  });

  it("allows callers to opt back into recovery source issues", async () => {
    await issuesApi.list("company-1", { excludeRecoverySourcesWithOpenSuccessors: false });

    expect(mockGet).toHaveBeenCalledWith("/companies/company-1/issues");
  });
});
