import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { autonomousLoopWatchdogApi } from "./autonomousLoopWatchdog";

describe("autonomousLoopWatchdogApi.preview", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ mode: "preview", readOnly: true, candidates: [] });
  });

  it("requests the read-only preview with the conservative default limit", async () => {
    await autonomousLoopWatchdogApi.preview("company-1");

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/autonomous-loop-watchdog/preview?limit=25",
    );
  });

  it("passes custom preview limits through to the endpoint", async () => {
    await autonomousLoopWatchdogApi.preview("company-1", { limit: 50 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/autonomous-loop-watchdog/preview?limit=50",
    );
  });
});
