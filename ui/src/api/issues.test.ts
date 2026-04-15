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

  it("does not exclude recovery sources with open successors by default", async () => {
    await issuesApi.list("company-1");

    expect(mockGet).toHaveBeenCalledWith("/companies/company-1/issues");
  });

  it("allows callers to opt into excluding recovery source issues", async () => {
    await issuesApi.list("company-1", { excludeRecoverySourcesWithOpenSuccessors: true });

    expect(mockGet).toHaveBeenCalledWith(
      "/companies/company-1/issues?excludeRecoverySourcesWithOpenSuccessors=true",
    );
  });
});
