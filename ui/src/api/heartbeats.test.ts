import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatRunLogStreamPath, heartbeatsApi } from "./heartbeats";

describe("heartbeatsApi.liveRunsForCompany", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("keeps the legacy numeric minCount signature", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", 4);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=4");
  });

  it("passes minCount and limit options to the company live-runs endpoint", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", { minCount: 50, limit: 50 });

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
