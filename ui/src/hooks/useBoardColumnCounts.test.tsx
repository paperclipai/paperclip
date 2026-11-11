// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { defaultIssueFilterState } from "../lib/issue-filters";
import { useBoardColumnCounts } from "./useBoardColumnCounts";

const count = vi.hoisted(() => vi.fn());
vi.mock("../api/issues", () => ({ issuesApi: { count } }));

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  count.mockReset();
});

it("keeps the last total and reports the error when a count refetch fails", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  let result!: ReturnType<typeof useBoardColumnCounts>;
  function Harness() {
    result = useBoardColumnCounts({
      companyId: "company-1", enabled: true, filters: {}, viewState: defaultIssueFilterState,
      statuses: ["done"], columnPageLengths: [200], cardLimit: 200,
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  count.mockResolvedValue({ count: 258 });
  await act(async () => root!.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>));
  await vi.waitFor(() => expect(result.columnCounts).toEqual({ done: 258 }));
  expect(result.hasError).toBe(false);

  count.mockRejectedValue(new Error("Count unavailable"));
  await act(() => queryClient.refetchQueries());
  await vi.waitFor(() => expect(result.hasError).toBe(true));
  expect(result.columnCounts).toEqual({ done: 258 });
  expect(result.cappedStatuses).toEqual(["done"]);
});
