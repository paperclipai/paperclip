import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { sidebarBadgesApi } from "./sidebarBadges";

describe("sidebarBadgesApi.get", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({});
  });

  it("passes the local today date when provided", async () => {
    await sidebarBadgesApi.get("company-1", { today: "2026-04-19" });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/sidebar-badges?today=2026-04-19",
    );
  });
});
