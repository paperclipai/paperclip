// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepPreviousDataForSameQueryTail } from "./query-placeholder-data";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function Harness({
  issueId,
  fetchIssueRuns,
}: {
  issueId: string;
  fetchIssueRuns: (issueId: string) => Promise<string[]>;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["issues", "live-runs", issueId],
    queryFn: () => fetchIssueRuns(issueId),
    placeholderData: keepPreviousDataForSameQueryTail(issueId),
  });

  return (
    <div data-testid="query-state">
      {JSON.stringify({
        issueId,
        runs: data ?? null,
        isLoading,
      })}
    </div>
  );
}

describe("keepPreviousDataForSameQueryTail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("clears issue-scoped placeholder data when the query tail changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    const root = createRoot(container);
    const issueBRuns = createDeferred<string[]>();

    queryClient.setQueryData(["issues", "live-runs", "issue-a"], ["run-a"]);

    const fetchIssueRuns = (issueId: string) => {
      if (issueId === "issue-a") return Promise.resolve(["run-a"]);
      if (issueId === "issue-b") return issueBRuns.promise;
      return Promise.resolve([]);
    };

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness issueId="issue-a" fetchIssueRuns={fetchIssueRuns} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      issueId: "issue-a",
      runs: ["run-a"],
      isLoading: false,
    }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness issueId="issue-b" fetchIssueRuns={fetchIssueRuns} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toBe(JSON.stringify({
      issueId: "issue-b",
      runs: null,
      isLoading: true,
    }));

    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });
});
