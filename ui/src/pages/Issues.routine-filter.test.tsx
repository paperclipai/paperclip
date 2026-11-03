// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { MemoryRouter } from "@/lib/router";
import { useLocation } from "react-router-dom";
import { Issues } from "./Issues";
import type { IssueSort } from "../lib/issue-sort";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: false }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/issues", () => ({ issuesApi: { listCompact: mocks.list } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("../hooks/useUpdateIssueMutation", () => ({ useUpdateIssueMutation: () => ({ mutate: vi.fn() }) }));
vi.mock("../components/IssuesList", () => ({ IssuesList: ({ issues, routineTasksOnly, onRoutineTasksOnlyChange, onLoadMoreIssues, sort, onSortChange, searchFilters }: {
  searchFilters?: Record<string, unknown>;
  sort?: IssueSort; onSortChange: (sort: IssueSort) => void; issues: Issue[]; routineTasksOnly: boolean; onRoutineTasksOnlyChange: (checked: boolean) => void; onLoadMoreIssues: () => void;
}) => <>
  <label><input type="checkbox" checked={routineTasksOnly} onChange={event => onRoutineTasksOnlyChange(event.target.checked)} />Routine tasks</label>
  <button onClick={onLoadMoreIssues}>Load more</button>
  <button data-sort onClick={() => onSortChange({ sortField: "created", sortDir: sort?.sortDir === "desc" ? "asc" : "desc" })}>Created</button>
  <output data-search-filters={JSON.stringify(searchFilters)}>{issues.map(issue => issue.id).join(",")}</output>
  <p>{useLocation().search}</p>
</> }));

afterEach(() => { localStorage.clear(); vi.clearAllMocks(); });

it.each([403, 404, 429])("handles a %s task-list refresh using the shared read state", async status => {
  mocks.list.mockResolvedValue([{ id: "retained-task" }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?view=all"]}><Issues /></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("retained-task"));
    mocks.list.mockRejectedValue(new ApiError("request_failed", status, null));
    await client.invalidateQueries({ queryKey: queryKeys.issues.list("company") });
    if (status === 429) {
      expect(host.querySelector("output")?.textContent).toBe("retained-task");
      expect(host.querySelector('[data-query-view="error"]')).toBeNull();
    } else {
      await vi.waitFor(() => expect(host.querySelector('[data-query-view="error"]')).not.toBeNull());
      expect(host.querySelector("output")).toBeNull();
      expect(host.textContent).not.toContain("request_failed");
    }
  } finally { flushSync(() => root.unmount()); client.clear(); host.remove(); }
});

it("offers retry after an exhausted initial task-list 429", async () => {
  mocks.list.mockRejectedValue(new ApiError("rate_limited", 429, null));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?view=all"]}><Issues /></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(() => expect(host.querySelector('[data-query-view="error"]')).not.toBeNull());
    expect(host.querySelector("output")).toBeNull();
    mocks.list.mockResolvedValue([{ id: "recovered-task" }]);
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent?.trim() === "Retry")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("recovered-task"));
  } finally { flushSync(() => root.unmount()); client.clear(); host.remove(); }
});

it("fetches routine tasks before pagination and removes the URL filter when unchecked", async () => {
  mocks.list.mockImplementation(async (_company, filters) => filters.originKind === "routine_execution"
    ? Array.from({ length: filters.offset ? 1 : 100 }, (_, index) => ({ id: `routine-${filters.offset + index}` }))
    : [{ id: "human-task" }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?view=all&originKind=routine_execution"]}><Issues /></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toContain("routine-99"));
    expect(host.querySelector("input")?.checked).toBe(true);
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({
      originKind: "routine_execution", includeAgentCreatedTasks: true, includeRoutineExecutions: true, offset: 0,
    }), expect.anything());
    flushSync(() => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toContain("routine-100"));
    expect(mocks.list.mock.lastCall?.[1]).toMatchObject({ originKind: "routine_execution", offset: 100 });
    flushSync(() => host.querySelector("input")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("human-task"));
    expect(mocks.list.mock.lastCall?.[1]).toMatchObject({ includeAgentCreatedTasks: false, offset: 0 });
    expect(mocks.list.mock.lastCall?.[1].originKind).toBeUndefined();
    expect(host.querySelector("p")?.textContent).toBe("?view=all");
  } finally {
    flushSync(() => root.unmount()); client.clear(); host.remove();
  }
});

it("restores URL sorting, resets paging on a sort click, and preserves routine filters", async () => {
  mocks.list.mockImplementation(async (_company, filters) => Array.from({ length: filters.offset ? 1 : 100 }, (_, index) => ({ id: `${filters.sortDir}-${filters.offset + index}` })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?view=all&originKind=routine_execution&sortField=created&sortDir=desc&participantAgentId=agent"]}><Issues /></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toContain("desc-99"));
    expect(mocks.list.mock.lastCall?.[1]).toMatchObject({ sortField: "created", sortDir: "desc", originKind: "routine_execution", offset: 0 });
    expect(JSON.parse(host.querySelector("output")!.getAttribute("data-search-filters")!)).toEqual({
      originKind: "routine_execution", participantAgentId: "agent",
    });
    flushSync(() => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toContain("desc-100"));
    flushSync(() => host.querySelector<HTMLButtonElement>("[data-sort]")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toContain("asc-99"));
    expect(mocks.list.mock.lastCall?.[1]).toMatchObject({ sortField: "created", sortDir: "asc", originKind: "routine_execution", participantAgentId: "agent", offset: 0 });
    const params = new URLSearchParams(host.querySelector("p")!.textContent!);
    expect(Object.fromEntries(params)).toMatchObject({ view: "all", originKind: "routine_execution", sortField: "created", sortDir: "asc", participantAgentId: "agent" });
  } finally {
    flushSync(() => root.unmount()); client.clear(); host.remove();
  }
});
