import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatsApi } from "./heartbeats";

describe("heartbeatsApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("requests summary rows for hot-path history consumers", async () => {
    await heartbeatsApi.list("company-1", undefined, 200, { summary: true });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?limit=200&summary=true");
  });

  it("keeps full row requests as the default for run-history screens", async () => {
    await heartbeatsApi.list("company-1", "agent-1", 25);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?agentId=agent-1&limit=25");
  });
});

describe("heartbeatsApi.activeRunForIssue", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it("returns the run payload when the issue has an active run", async () => {
    mockApi.get.mockResolvedValue({ id: "run-1" });

    await expect(heartbeatsApi.activeRunForIssue("issue-1")).resolves.toEqual({ id: "run-1" });
    expect(mockApi.get).toHaveBeenCalledWith("/issues/issue-1/active-run");
  });

  // The server answers "no active run" with 204, which the shared client resolves as
  // `undefined`. React Query rejects a queryFn that resolves `undefined`, so the absent
  // run has to reach callers as an explicit `null`.
  it("normalizes the 204 no-active-run response to null", async () => {
    mockApi.get.mockResolvedValue(undefined);

    await expect(heartbeatsApi.activeRunForIssue("issue-1")).resolves.toBeNull();
  });
});

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
