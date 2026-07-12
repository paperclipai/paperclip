import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applySharedPollingResult } from "./useSharedPolling";

describe("applySharedPollingResult", () => {
  it("drops result messages that are older than local query state", () => {
    const queryClient = new QueryClient();
    const queryKey = ["live-runs", "company-1"];
    queryClient.setQueryData(queryKey, [{ id: "run-1", lastEventAt: "newer" }], { updatedAt: 2_000 });

    const applied = applySharedPollingResult(queryClient, queryKey, {
      type: "result",
      key: "company:live-runs",
      from: "leader",
      at: 1_000,
      dataUpdatedAt: 1_000,
      data: [{ id: "run-1", lastEventAt: "older" }],
    });

    expect(applied).toBe(false);
    expect(queryClient.getQueryData(queryKey)).toEqual([{ id: "run-1", lastEventAt: "newer" }]);
    expect(queryClient.getQueryState(queryKey)?.dataUpdatedAt).toBe(2_000);
  });

  it("applies newer result messages with the producer dataUpdatedAt", () => {
    const queryClient = new QueryClient();
    const queryKey = ["live-runs", "company-1"];
    queryClient.setQueryData(queryKey, [{ id: "run-1", lastEventAt: "older" }], { updatedAt: 1_000 });

    const applied = applySharedPollingResult(queryClient, queryKey, {
      type: "result",
      key: "company:live-runs",
      from: "leader",
      at: 4_000,
      dataUpdatedAt: 3_000,
      data: [{ id: "run-1", lastEventAt: "newer" }],
    });

    expect(applied).toBe(true);
    expect(queryClient.getQueryData(queryKey)).toEqual([{ id: "run-1", lastEventAt: "newer" }]);
    expect(queryClient.getQueryState(queryKey)?.dataUpdatedAt).toBe(3_000);
  });
});
