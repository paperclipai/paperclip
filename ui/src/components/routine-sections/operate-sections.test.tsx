// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsSection, ActivitySection } from "./operate-sections";
import { RoutineDetailContext, type RoutineDetailContextValue } from "./context";

const { list, update, renderList, toast } = vi.hoisted(() => ({
  list: vi.fn(), update: vi.fn(), renderList: vi.fn(), toast: vi.fn(),
}));
vi.mock("@/api/issues", () => ({ issuesApi: { list, update } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: toast }) }));
vi.mock("../IssuesList", () => ({ IssuesList: (props: unknown) => { renderList(props); return <div>Issue list</div>; } }));
vi.mock("../RoutineHistoryTab", () => ({ RoutineHistoryTab: () => null }));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const context = {
  companyId: "company-1", routine: { id: "routine-1" }, agents: [], projects: [], activity: [],
} as unknown as RoutineDetailContextValue;
function render(section = <RunsSection />) {
  flushSync(() => root.render(
    <QueryClientProvider client={queryClient}>
      <RoutineDetailContext.Provider value={context}>{section}</RoutineDetailContext.Provider>
    </QueryClientProvider>,
  ));
}
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("routine operations", () => {
  it("loads this routine's execution issues and keeps list search scoped to the same routine", async () => {
    const issues = [{ id: "execution-1", title: "Check deployment", status: "done" }];
    list.mockResolvedValue(issues);
    render();
    await vi.waitFor(() => expect(renderList.mock.lastCall?.[0].issues).toEqual(issues));
    expect(list).toHaveBeenCalledWith("company-1", { originKind: "routine_execution", originId: "routine-1" });
    expect(renderList.mock.lastCall?.[0].searchFilters).toEqual({ originKind: "routine_execution", originId: "routine-1" });
    expect(renderList.mock.lastCall?.[0].issueLinkState.issueDetailBreadcrumb.href).toBe("/routines/routine-1/runs");
  });

  it("surfaces issue loading and update failures", async () => {
    list.mockRejectedValue(new Error("Could not load execution issues"));
    render();
    await vi.waitFor(() => expect(renderList.mock.lastCall?.[0].error?.message).toBe("Could not load execution issues"));
    update.mockRejectedValue(new Error("Update denied"));
    renderList.mock.lastCall?.[0].onUpdateIssue("execution-1", { status: "done" });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ body: "Update denied", tone: "error" })));
  });

  it("distinguishes activity loading and failures from an empty timeline", () => {
    render(<ActivitySection isLoading />);
    expect(container.textContent).toContain("Loading activity");
    expect(container.textContent).not.toContain("No activity yet");
    render(<ActivitySection error={new Error("Activity unavailable")} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Activity unavailable");
  });
});
