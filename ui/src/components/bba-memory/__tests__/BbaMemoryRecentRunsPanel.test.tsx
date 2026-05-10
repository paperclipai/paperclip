import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("../../../api/bbaMemory", () => ({
  fetchRecentBbaRuns: vi.fn(),
  fetchBbaStats: vi.fn(),
}));

import * as bbaApi from "../../../api/bbaMemory";
import BbaMemoryRecentRunsPanel from "../BbaMemoryRecentRunsPanel";

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

const emptyStats = {
  companyId: "c1",
  windowDays: 7,
  totalRuns: 0,
  successCount: 0,
  failureCount: 0,
  partialCount: 0,
  successRatePct: null,
  topFailureClasses: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BbaMemoryRecentRunsPanel", () => {
  it("renders loading state when both queries are loading", () => {
    mockedFetchRuns.mockImplementation(() => new Promise(() => {}));
    mockedFetchStats.mockImplementation(() => new Promise(() => {}));

    render(<BbaMemoryRecentRunsPanel companyId="c1" />, { wrapper: makeWrapper() });

    const loading = screen.getByTestId("bba-panel-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
  });

  it("renders empty state when runs.total is 0", async () => {
    mockedFetchRuns.mockResolvedValue({ companyId: "c1", limit: 20, total: 0, runs: [] });
    mockedFetchStats.mockResolvedValue(emptyStats);

    render(<BbaMemoryRecentRunsPanel companyId="c1" />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByTestId("bba-panel-empty")).toBeInTheDocument());
    expect(screen.getByText("No BBA runs recorded yet.")).toBeVisible();
  });

  it("renders 2 runs in the table with correct outcome classes", async () => {
    mockedFetchRuns.mockResolvedValue({
      companyId: "c1",
      limit: 20,
      total: 2,
      runs: [
        {
          id: 1,
          startedAt: "2026-05-10T12:00:00Z",
          finishedAt: "2026-05-10T12:00:05Z",
          source: "manual",
          trigger: "issue:I1",
          outcome: "success",
          failureClass: null,
          durationMs: 5000,
          meta: null,
        },
        {
          id: 2,
          startedAt: "2026-05-10T11:00:00Z",
          finishedAt: "2026-05-10T11:00:03Z",
          source: "manual",
          trigger: "issue:I2",
          outcome: "failure",
          failureClass: "UNKNOWN",
          durationMs: 3000,
          meta: null,
        },
      ],
    });
    mockedFetchStats.mockResolvedValue({
      ...emptyStats,
      totalRuns: 2,
      successCount: 1,
      failureCount: 1,
      successRatePct: 50,
      topFailureClasses: [{ class: "UNKNOWN", count: 1 }],
    });

    render(<BbaMemoryRecentRunsPanel companyId="c1" />, { wrapper: makeWrapper() });

    const table = await screen.findByTestId("bba-panel-table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(screen.getByText("success")).toHaveClass("text-green-700", "bg-green-50");
    expect(screen.getByText("failure")).toHaveClass("text-red-700", "bg-red-50");
    expect(within(rows[1]).getByText("UNKNOWN")).toBeVisible();
  });

  it("renders error state when runsQuery errors", async () => {
    mockedFetchRuns.mockRejectedValue(new Error("boom"));
    mockedFetchStats.mockResolvedValue(emptyStats);

    render(<BbaMemoryRecentRunsPanel companyId="c1" />, { wrapper: makeWrapper() });

    const error = await screen.findByTestId("bba-panel-error");
    expect(error).toHaveTextContent("Failed to load BBA runs");
    expect(error).toHaveTextContent("boom");
  });

  it("renders stats card with success rate, total runs, and top failure", async () => {
    mockedFetchRuns.mockResolvedValue({ companyId: "c1", limit: 20, total: 0, runs: [] });
    mockedFetchStats.mockResolvedValue({
      ...emptyStats,
      totalRuns: 12,
      successCount: 9,
      failureCount: 3,
      successRatePct: 75.5,
      topFailureClasses: [{ class: "NETWORK", count: 3 }],
    });

    render(<BbaMemoryRecentRunsPanel companyId="c1" />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByTestId("bba-stats-cards")).toBeInTheDocument());
    expect(screen.getByText("75.5%")).toBeVisible();
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByText("NETWORK")).toBeVisible();
  });

  it("snapshot of populated state", async () => {
    mockedFetchRuns.mockResolvedValue({
      companyId: "c1",
      limit: 20,
      total: 1,
      runs: [
        {
          id: 1,
          startedAt: "2026-05-10T12:00:00Z",
          finishedAt: "2026-05-10T12:00:05Z",
          source: "manual",
          trigger: "issue:I1",
          outcome: "success",
          failureClass: null,
          durationMs: 5000,
          meta: null,
        },
      ],
    });
    mockedFetchStats.mockResolvedValue({
      ...emptyStats,
      totalRuns: 1,
      successCount: 1,
      successRatePct: 100,
    });

    const { container } = render(<BbaMemoryRecentRunsPanel companyId="c1" />, {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(screen.getByTestId("bba-panel-table")).toBeInTheDocument());
    expect(container.firstChild?.textContent).toMatchInlineSnapshot(
      `"BBA Memory — Recent RunsSuccess rate (7d)100%Total runs (7d)1Top failure—StartedSourceTriggerOutcomeFailure classDuration5/10/2026, 3:00:00 PMmanualissue:I1success—5.0s"`,
    );
  });
});
