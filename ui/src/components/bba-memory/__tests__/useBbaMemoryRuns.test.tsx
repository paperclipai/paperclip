import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("../../../api/bbaMemory", () => ({
  fetchRecentBbaRuns: vi.fn(),
  fetchBbaStats: vi.fn(),
}));

import * as bbaApi from "../../../api/bbaMemory";
import { useBbaMemoryRuns } from "../useBbaMemoryRuns";

const mockedFetchRuns = vi.mocked(bbaApi.fetchRecentBbaRuns);
const mockedFetchStats = vi.mocked(bbaApi.fetchBbaStats);

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const run = {
  id: 1,
  startedAt: "2026-05-10T12:00:00Z",
  finishedAt: null,
  source: "manual",
  trigger: null,
  outcome: "success" as const,
  failureClass: null,
  durationMs: 1000,
  meta: null,
};

const stats = {
  companyId: "c1",
  windowDays: 7,
  totalRuns: 1,
  successCount: 1,
  failureCount: 0,
  partialCount: 0,
  successRatePct: 100,
  topFailureClasses: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useBbaMemoryRuns", () => {
  it("returns runs and stats from successful queries", async () => {
    mockedFetchRuns.mockResolvedValue({ companyId: "c1", limit: 20, total: 1, runs: [run] });
    mockedFetchStats.mockResolvedValue(stats);

    const { result } = renderHook(() => useBbaMemoryRuns("c1"), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.runs).toEqual([run]);
    expect(result.current.stats).toEqual(stats);
  });

  it("isLoading is true when either query is loading", () => {
    mockedFetchRuns.mockImplementation(() => new Promise(() => {}));
    mockedFetchStats.mockResolvedValue(stats);

    const { result } = renderHook(() => useBbaMemoryRuns("c1"), { wrapper: makeWrapper() });

    expect(result.current.isLoading).toBe(true);
  });

  it("isError is true when either query errors, error is preserved", async () => {
    const err = new Error("boom");
    mockedFetchRuns.mockRejectedValue(err);
    mockedFetchStats.mockResolvedValue(stats);

    const { result } = renderHook(() => useBbaMemoryRuns("c1"), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(err);
  });

  it("respects custom limit and windowDays options", async () => {
    mockedFetchRuns.mockResolvedValue({ companyId: "c1", limit: 5, total: 0, runs: [] });
    mockedFetchStats.mockResolvedValue({ ...stats, windowDays: 30 });

    const { result } = renderHook(
      () => useBbaMemoryRuns("c1", { limit: 5, windowDays: 30 }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedFetchRuns).toHaveBeenCalledWith("c1", expect.objectContaining({ limit: 5 }));
    expect(mockedFetchStats).toHaveBeenCalledWith("c1", expect.objectContaining({ windowDays: 30 }));
  });

  it("refetch triggers both runs and stats refetch", async () => {
    mockedFetchRuns.mockResolvedValue({ companyId: "c1", limit: 20, total: 1, runs: [run] });
    mockedFetchStats.mockResolvedValue(stats);

    const { result } = renderHook(() => useBbaMemoryRuns("c1"), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    result.current.refetch();

    await waitFor(() => expect(mockedFetchRuns).toHaveBeenCalledTimes(2));
    expect(mockedFetchStats).toHaveBeenCalledTimes(2);
  });
});
