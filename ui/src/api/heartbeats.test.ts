import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatsApi } from "./heartbeats";

describe("heartbeatsApi.liveRunsForCompany", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue(undefined);
  });

  it("keeps the legacy numeric minCount signature", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", 4);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=4");
  });

  it("passes minCount and limit options to the company live-runs endpoint", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", { minCount: 50, limit: 50 });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=50&limit=50");
  });

  it("sends an operator cancellation reason", async () => {
    await heartbeatsApi.cancel("run-1", { reason: "manual stop" });

    expect(mockApi.post).toHaveBeenCalledWith("/heartbeat-runs/run-1/cancel", { reason: "manual stop" });
  });
});
