// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { MemoryRouter } from "@/lib/router";
import { useLocation } from "react-router-dom";
import { Issues } from "./Issues";

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
vi.mock("../components/IssuesList", () => ({ IssuesList: ({ issues, routineTasksOnly, onRoutineTasksOnlyChange, onLoadMoreIssues }: {
  issues: Issue[]; routineTasksOnly: boolean; onRoutineTasksOnlyChange: (checked: boolean) => void; onLoadMoreIssues: () => void;
}) => <>
  <label><input type="checkbox" checked={routineTasksOnly} onChange={event => onRoutineTasksOnlyChange(event.target.checked)} />Routine tasks</label>
  <button onClick={onLoadMoreIssues}>Load more</button>
  <output>{issues.map(issue => issue.id).join(",")}</output>
  <p>{useLocation().search}</p>
</> }));

afterEach(() => { localStorage.clear(); vi.clearAllMocks(); });

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
