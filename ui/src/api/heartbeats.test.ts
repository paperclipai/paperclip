import { describe, expect, it, beforeEach, vi } from "vitest";

const mockApi = { get: vi.fn(), post: vi.fn() };

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatRunLogStreamPath, heartbeatsApi } from "./heartbeats";

describe("heartbeatsApi.liveRunsForCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the legacy numeric minCount signature", () => {
    mockApi.get.mockResolvedValue([]);
    heartbeatsApi.liveRunsForCompany("company-1", 50);
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=50");
  });

  it("passes minCount and limit options to the company live-runs endpoint", () => {
    mockApi.get.mockResolvedValue([]);
    heartbeatsApi.liveRunsForCompany("company-1", 50, 50);
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=50&limit=50");
  });
});

describe("heartbeatsApi.logStreamPath", () => {
  it("builds a stream path under /api for EventSource", () => {
    expect(heartbeatsApi.logStreamPath("run-1", 42, 99)).toBe(
      "/api/heartbeat-runs/run-1/log/stream?offset=42&limitBytes=99",
    );
    expect(heartbeatRunLogStreamPath("run/with spaces", 0, 256000)).toContain(
      "/api/heartbeat-runs/run%2Fwith%20spaces/log/stream",
    );
  });
});
