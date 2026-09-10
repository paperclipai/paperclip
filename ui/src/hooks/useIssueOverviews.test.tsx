// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueOverview } from "@paperclipai/shared";
import { ISSUE_OVERVIEW_BATCH_SIZE } from "../api/issue-overviews";
import { fetchIssueOverviews, useIssueOverviews } from "./useIssueOverviews";

const mockApi = vi.hoisted(() => ({
  getByIssueIds: vi.fn(),
}));

vi.mock("../api/issue-overviews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issue-overviews")>();
  return { ...actual, issueOverviewsApi: mockApi };
});

function overview(issueId: string): IssueOverview {
  return {
    issueId,
    phase: "in_review",
    phaseSource: "status",
    blocked: false,
    project: null,
    parent: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    blocker: null,
    pullRequests: [],
    delivery: null,
  };
}

function idAt(index: number) {
  return `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
}

describe("fetchIssueOverviews", () => {
  beforeEach(() => {
    mockApi.getByIssueIds.mockReset();
  });

  it("reads long id lists in chunks of 100", async () => {
    mockApi.getByIssueIds.mockImplementation(async (_companyId: string, chunk: string[]) => ({
      items: chunk.map(overview),
      observedAt: `2026-02-0${Math.min(chunk.length, 9)}T10:00:00.000Z`,
    }));

    const ids = Array.from({ length: 250 }, (_value, index) => idAt(index));
    const snapshot = await fetchIssueOverviews("company-1", ids);

    expect(mockApi.getByIssueIds).toHaveBeenCalledTimes(3);
    expect(mockApi.getByIssueIds.mock.calls.map(([, chunk]) => (chunk as string[]).length)).toEqual([
      ISSUE_OVERVIEW_BATCH_SIZE,
      ISSUE_OVERVIEW_BATCH_SIZE,
      50,
    ]);
    // Chunks arrive in order, so the newest observation is the last one read.
    expect(snapshot.observedAt).toBe("2026-02-09T10:00:00.000Z");
    expect(snapshot.items).toHaveLength(250);
    expect(snapshot.failedIssueIds).toEqual([]);
  });

  it("keeps the ids that loaded when one chunk fails", async () => {
    const ids = Array.from({ length: 150 }, (_value, index) => idAt(index));
    mockApi.getByIssueIds.mockImplementation(async (_companyId: string, chunk: string[]) => {
      if (chunk[0] === ids[100]) throw new Error("Request failed with status 500");
      return { items: chunk.map(overview), observedAt: "2026-02-01T10:00:00.000Z" };
    });

    const snapshot = await fetchIssueOverviews("company-1", ids);

    expect(snapshot.items).toHaveLength(100);
    expect(snapshot.failedIssueIds).toEqual(ids.slice(100));
  });

  it("fails the read when every chunk fails", async () => {
    mockApi.getByIssueIds.mockRejectedValue(new Error("Request failed with status 500"));
    await expect(fetchIssueOverviews("company-1", [idAt(1), idAt(2)])).rejects.toThrow(
      "Request failed with status 500",
    );
  });
});

function Probe({ companyId, issueIds }: { companyId: string | null; issueIds: string[] }) {
  const { byId, isPending, error, dataUpdatedAt, refetch } = useIssueOverviews(companyId, issueIds);
  return (
    <div
      data-by-ids={[...byId.keys()].sort().join(",")}
      data-pending={String(isPending)}
      data-error={error?.message ?? ""}
      data-updated-at={String(dataUpdatedAt)}
      data-refetch={String(typeof refetch)}
    />
  );
}

describe("useIssueOverviews", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    mockApi.getByIssueIds.mockReset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  function render(companyId: string | null, issueIds: string[]) {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe companyId={companyId} issueIds={issueIds} />
        </QueryClientProvider>,
      );
    });
  }

  function probe() {
    return container.firstElementChild as HTMLElement;
  }

  it("does not read anything without a company or an id", () => {
    render(null, []);
    expect(mockApi.getByIssueIds).not.toHaveBeenCalled();
    // Nothing to load: a caller must not be shown a spinner it can never leave.
    expect(probe().dataset.pending).toBe("false");
    expect(probe().dataset.error).toBe("");
    expect(probe().dataset.byIds).toBe("");
  });

  it("exposes loaded overviews by issue id", async () => {
    mockApi.getByIssueIds.mockResolvedValue({
      items: [overview(idAt(1)), overview(idAt(2))],
      observedAt: "2026-02-01T10:00:00.000Z",
    });

    render("company-1", [idAt(2), idAt(1), idAt(1)]);

    await vi.waitFor(() => expect(probe().dataset.byIds).toBe(`${idAt(1)},${idAt(2)}`));
    expect(probe().dataset.pending).toBe("false");
    expect(probe().dataset.error).toBe("");
    expect(Number(probe().dataset.updatedAt)).toBeGreaterThan(0);
    expect(probe().dataset.refetch).toBe("function");
    // Sorted and deduplicated so the request matches the declared cap.
    expect(mockApi.getByIssueIds).toHaveBeenCalledWith("company-1", [idAt(1), idAt(2)]);
  });

  it("keeps one query for one id set across re-renders that rebuild the array", async () => {
    mockApi.getByIssueIds.mockResolvedValue({
      items: [overview(idAt(1)), overview(idAt(2))],
      observedAt: "2026-02-01T10:00:00.000Z",
    });

    render("company-1", [idAt(2), idAt(1)]);
    await vi.waitFor(() => expect(probe().dataset.byIds).toBe(`${idAt(1)},${idAt(2)}`));

    // A board re-renders on every filter change and hands over a new array.
    render("company-1", [idAt(1), idAt(2), idAt(1)]);
    await vi.waitFor(() => expect(probe().dataset.pending).toBe("false"));

    expect(mockApi.getByIssueIds).toHaveBeenCalledTimes(1);
    expect(probe().dataset.byIds).toBe(`${idAt(1)},${idAt(2)}`);
  });

  it("reports a partial batch explicitly while keeping the ids that loaded", async () => {
    const ids = Array.from({ length: 150 }, (_value, index) => idAt(index));
    mockApi.getByIssueIds.mockImplementation(async (_companyId: string, chunk: string[]) => {
      if (chunk[0] === ids[100]) throw new Error("Request failed with status 500");
      return { items: chunk.map(overview), observedAt: "2026-02-01T10:00:00.000Z" };
    });

    render("company-1", ids);

    await vi.waitFor(() => expect(probe().dataset.error).toBe("50 of 150 issue overviews could not be loaded"));
    expect((probe().dataset.byIds ?? "").split(",")).toHaveLength(100);
    expect(probe().dataset.pending).toBe("false");
  });
});
