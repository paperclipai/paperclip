// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: mocks.list } }));

import { companyProjectsQuery } from "./company-projects-query";
import { queryKeys } from "./queryKeys";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const active = { id: "p-active", name: "Active", archivedAt: null };
const archived = { id: "p-archived", name: "Archived", archivedAt: "2026-11-01T00:00:00.000Z" };

describe("companyProjectsQuery", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([active, archived]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  it("serves active-only and archive-inclusive consumers from one request", async () => {
    const seen: Record<string, string[] | undefined> = {};
    function Sidebar() {
      const { data } = useQuery(companyProjectsQuery("company-1"));
      seen.sidebar = data?.map((project) => project.id);
      return null;
    }
    function Inbox() {
      const { data } = useQuery(companyProjectsQuery("company-1", { includeArchived: true }));
      seen.inbox = data?.map((project) => project.id);
      return null;
    }

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(seen.sidebar).toEqual(["p-active"]);
      expect(seen.inbox).toEqual(["p-active", "p-archived"]);
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("company-1", { includeArchived: true });

    // Project mutations invalidate the company prefix; both views refresh from one read.
    mocks.list.mockResolvedValue([active, { ...archived, archivedAt: null }]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all("company-1") });
    });
    await vi.waitFor(() => expect(seen.sidebar).toEqual(["p-active", "p-archived"]));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});
