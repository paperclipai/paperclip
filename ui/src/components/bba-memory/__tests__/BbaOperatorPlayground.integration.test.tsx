import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("../../../api/bbaMemory", () => ({
  fetchRecentBbaRuns: vi.fn(),
  fetchBbaStats: vi.fn(),
  executeBbaBet: vi.fn(),
}));

import * as bbaApi from "../../../api/bbaMemory";
import { BbaOperatorPlayground } from "../BbaOperatorPlayground";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchRuns.mockResolvedValue({ companyId: "c1", limit: 20, total: 0, runs: [] });
  mockedFetchStats.mockResolvedValue({
    companyId: "c1",
    windowDays: 7,
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    partialCount: 0,
    successRatePct: null,
    topFailureClasses: [],
  });
});

describe("BbaOperatorPlayground integration", () => {
  it("full mount: shows loading, then empty state for new company", async () => {
    render(<BbaOperatorPlayground companyId="c1" />, { wrapper: makeWrapper() });

    expect(screen.getByTestId("bba-panel-loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("bba-panel-empty")).toBeInTheDocument());
  });

  it("full mount: switching bookmaker preset re-renders execute panel", async () => {
    render(<BbaOperatorPlayground companyId="c1" />, { wrapper: makeWrapper() });

    fireEvent.change(screen.getByTestId("bookmaker-preset-select"), {
      target: { value: "betano" },
    });

    expect(screen.getByTestId("bet-summary-card")).toHaveTextContent("Betano");
    fireEvent.click(screen.getByTestId("place-bet-button"));
    expect(screen.getByTestId("confirm-modal-overlay")).toHaveTextContent("Betano");
  });

  it("full mount: place-bet button is enabled when default presets loaded", () => {
    render(<BbaOperatorPlayground companyId="c1" />, { wrapper: makeWrapper() });

    expect(screen.getByTestId("place-bet-button")).not.toBeDisabled();
  });
});
