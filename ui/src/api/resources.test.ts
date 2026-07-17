import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("./client", () => ({ api: mockApi }));

import { resourcesApi } from "./resources";

describe("resourcesApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists active Resources by company and can include archived rows", async () => {
    mockApi.get.mockResolvedValue([]);

    await resourcesApi.list("company-1");
    await resourcesApi.list("company-1", true);

    expect(mockApi.get).toHaveBeenNthCalledWith(1, "/companies/company-1/resources");
    expect(mockApi.get).toHaveBeenNthCalledWith(2, "/companies/company-1/resources?includeArchived=true");
  });

  it("uses the Resource CRUD endpoints", async () => {
    const input = {
      key: "campaign",
      type: "git" as const,
      repository: "https://github.com/acme/campaign.git",
      sourcePath: null,
      defaultRef: "main",
      mountPath: "campaign",
      credentialRef: "secret-1",
      labels: { team: "marketing" },
    };

    await resourcesApi.create("company-1", input);
    await resourcesApi.get("resource-1");
    await resourcesApi.update("resource-1", { defaultRef: "release" });
    await resourcesApi.archive("resource-1");

    expect(mockApi.post).toHaveBeenCalledWith("/companies/company-1/resources", input);
    expect(mockApi.get).toHaveBeenCalledWith("/resources/resource-1");
    expect(mockApi.patch).toHaveBeenCalledWith("/resources/resource-1", { defaultRef: "release" });
    expect(mockApi.delete).toHaveBeenCalledWith("/resources/resource-1");
  });
});
