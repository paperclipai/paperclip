// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { MemoryRouter } from "@/lib/router";
import { useLocation, useNavigate } from "react-router-dom";
import { CoordinatorTasks } from "./CoordinatorTasks";
import { queryKeys } from "@/lib/queryKeys";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), attention: vi.fn(), breadcrumbs: vi.fn(), liveRuns: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mocks.liveRuns } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: mocks.list, listCompact: mocks.list, get: mocks.get, listLabels: async () => [], update: vi.fn() } }));
vi.mock("@/api/attention", () => ({ attentionApi: { taskIndex: mocks.attention } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "person" }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/components/TaskListToolbar", () => ({ TaskListToolbar: ({ filters, onViewChange, onLayoutChange }: { filters: { onChange: (value: { liveOnly?: boolean; priorities?: string[]; assignees?: string[]; statuses?: string[]; routineTasksOnly?: boolean }) => void }; onViewChange: (view: "blocked") => void; onLayoutChange: (layout: "board") => void }) => <>
  <button onClick={() => filters.onChange({ routineTasksOnly: true })}>Routine tasks</button>
  <button onClick={() => filters.onChange({ routineTasksOnly: false })}>Show other tasks</button>
  <button onClick={() => filters.onChange({ liveOnly: true })}>Live runs only</button>
  <button onClick={() => filters.onChange({ priorities: ["high"] })}>High priority</button>
  <button onClick={() => filters.onChange({ assignees: [], statuses: [] })}>Clear assignee and status</button>
  <button onClick={() => filters.onChange({ assignees: ["first", "second"], statuses: ["todo"] })}>Change assignee and status</button>
  <button onClick={() => onViewChange("blocked")}>Needs attention</button>
  <button onClick={() => onLayoutChange("board")}>Board view</button>
</> }));
vi.mock("@/components/TaskList", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/TaskList")>(),
  TaskList: ({ items, emptyState }: { items: { issue: { id: string; title: string } }[]; emptyState: React.ReactNode }) =>
    <div>{items.length ? items.map(item => <p key={item.issue.id} data-task-id={item.issue.id}>{item.issue.title}</p>) : emptyState}</div>,
}));

describe("Coordinator tasks using the proposed table", () => {
  let root: Root, host: HTMLDivElement, client: QueryClient;
  const pending = createIssue({ id: "pending", companyId: "company", status: "todo", parentId: null, title: "Needs a channel answer" });
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    mocks.liveRuns.mockResolvedValue([]);
    mocks.attention.mockResolvedValue({ taskIds: [pending.id] });
    mocks.get.mockResolvedValue(pending);
    mocks.list.mockImplementation(async (_company, filters) => filters.q ? [] : filters.ids ? [pending] : [createIssue({ id: "unrelated-review", companyId: "company", status: "in_review", parentId: null })]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
  async function mount(url: string) {
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><CoordinatorTasks /></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading tasks"));
  }
  it("loads the task index without descriptions or historical diagnostics", async () => {
    await mount("/issues");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ projection: "index", limit: 200 }), expect.anything());
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("opens routine task links, filters before paging, and lets the checkbox change the collection", async () => {
    const routine = createIssue({ id: "routine-task", companyId: "company", parentId: null, originKind: "routine_execution", title: "Routine report" });
    const manual = createIssue({ id: "manual-task", companyId: "company", parentId: null, originKind: "manual", title: "Manual report" });
    mocks.list.mockImplementation(async (_company, filters) => filters.originKind === "routine_execution" ? [routine] : [manual, routine]);
    await mount("/issues?view=all&originKind=routine_execution");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ originKind: "routine_execution", includeAgentCreatedTasks: true, includeRoutineExecutions: true, offset: 0 }), expect.anything());
    expect([...host.querySelectorAll("[data-task-id]")].map(row => row.getAttribute("data-task-id"))).toEqual([routine.id]);
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Show other tasks")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Manual report"));
    expect(mocks.list.mock.lastCall?.[1].originKind).toBeUndefined();
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Routine tasks")!.click());
    await vi.waitFor(() => expect(host.querySelector('[data-task-id="manual-task"]')).toBeNull());
  });

  it("filters pending-decision batches by routine origin without treating excluded IDs as missing", async () => {
    const routine = createIssue({ id: "routine-decision", companyId: "company", parentId: null, originKind: "routine_execution", title: "Routine decision" });
    mocks.attention.mockResolvedValue({ taskIds: [pending.id, routine.id] });
    mocks.list.mockResolvedValue([routine]);
    await mount("/issues?view=needs_attention&originKind=routine_execution");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ ids: [pending.id, routine.id], originKind: "routine_execution" }), expect.anything());
    expect(host.textContent).toContain("Routine decision");
    expect(host.textContent).not.toContain("couldn’t load");
  });

  it("loads diagnostics for visible production board cards and retains their next-step badges", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { this.callback([{ target, isIntersecting: !target.closest("[hidden]") } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      unobserve() {}
      disconnect() {}
    });
    const index = createIssue({ id: "board-task", companyId: "company", status: "in_progress", parentId: null, listProjection: "index" });
    const details = { ...index, listProjection: "rows", successfulRunHandoff: {
      required: true, hasLiveContinuation: false, state: "required", sourceRunId: "source-run", correctiveRunId: null,
      assigneeAgentId: null, detectedProgressSummary: null, createdAt: null,
    } };
    mocks.list.mockImplementation(async (_company, filters) => filters.projection === "rows" ? [details] : [index]);
    await mount("/issues");
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Board view")!.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Needs next step"]')).not.toBeNull());
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ projection: "rows", ids: [index.id] }), expect.anything());
  });

  it("enriches cards mounted by board pagination without replacing the collection", async () => {
    const indexes = Array.from({ length: 12 }, (_, index) => createIssue({ id: `board-task-${index}`, companyId: "company", status: "in_progress", parentId: null, listProjection: "index" }));
    mocks.list.mockImplementation(async (_company, filters) => filters.projection === "rows"
      ? indexes.filter(issue => filters.ids.includes(issue.id)).map(issue => ({ ...issue, successfulRunHandoff: {
        required: issue.id === "board-task-10", hasLiveContinuation: false,
      } })) : indexes);
    await mount("/issues");
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Board view")!.click());
    await vi.waitFor(() => expect(mocks.list.mock.calls.some(call => call[1].projection === "rows")).toBe(true));
    expect(host.querySelector('[aria-label="Needs next step"]')).toBeNull();
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent?.trim() === "Show 2 more")!.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Needs next step"]')).not.toBeNull());
    expect(mocks.list.mock.calls.filter(call => call[1].projection === "index")).toHaveLength(1);
  });

  it("batches pending task reads instead of fetching one enriched detail per decision", async () => {
    const ids = Array.from({ length: 105 }, (_, index) => `task-${index}`);
    mocks.attention.mockResolvedValue({ taskIds: ids });
    mocks.list.mockImplementation(async (_company, filters) => filters.ids.map((id: string) => createIssue({ id, companyId: "company", parentId: null })));
    await mount("/issues?view=needs_attention");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list.mock.calls.map(call => call[1].ids.length)).toEqual([100, 5]);
    expect(mocks.list.mock.calls.every(call => call[1].projection === "index")).toBe(true);
  });
  it("hydrates distinct pending task IDs independently of status and the first task-list page", async () => {
    await mount("/issues?view=needs_attention");
    expect([...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"))).toEqual(["pending"]);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith("company", expect.objectContaining({ ids: [pending.id], projection: "index" }), expect.anything());
    // Canonical attention invalidation refreshes the complete task membership.
    // No parallel status-based queue is involved.
    flushSync(() => client.setQueryData(coordinatorAttentionTasksQueryKey("company"), { taskIds: [pending.id] }));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-task-id]")).toHaveLength(1));
    flushSync(() => client.setQueryData(coordinatorAttentionTasksQueryKey("company"), { taskIds: [] }));
    await vi.waitFor(() => expect(host.textContent).toContain("No tasks need a decision."));
  });
  it("filters live tasks and updates when a run finishes, excluding terminal tasks with stale runs", async () => {
    mocks.list.mockResolvedValue([
      createIssue({ id: "live", companyId: "company", status: "in_progress", parentId: null }),
      createIssue({ id: "idle", companyId: "company", status: "todo", parentId: null }),
      createIssue({ id: "done", companyId: "company", status: "done", parentId: null }),
    ]);
    mocks.liveRuns.mockResolvedValue([{ issueId: "live", status: "running" }, { issueId: "done", status: "running" }]);
    await mount("/issues");
    await vi.waitFor(() => expect(mocks.liveRuns).toHaveBeenCalledWith("company"));
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Live runs only")!.click());
    await vi.waitFor(() => expect([...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"))).toEqual(["live"]));
    flushSync(() => client.setQueryData(queryKeys.liveRuns("company"), []));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-task-id]")).toHaveLength(0));
    expect(host.textContent).toContain("No tasks match this view");
  });
  it("preserves server search and scoped task links rather than searching only the first page", async () => {
    mocks.list.mockResolvedValue([createIssue({ id: "search-result", companyId: "company", parentId: null, description: "launch description" })]);
    await mount("/issues?q=launch&participantAgentId=agent&workspaceId=workspace");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ q: "launch", participantAgentId: "agent", workspaceId: "workspace", offset: 0 }), expect.anything());
    expect(host.querySelector('[data-task-id="search-result"]')).not.toBeNull();
  });
  it.each(["phrase found only in a comment", "PAP 7", "launch summaries"])("retains server matches for %s without a second local text filter", async query => {
    mocks.list.mockResolvedValue([createIssue({ id: "server-match", identifier: "PAP-7", title: "Launch summary", description: "Saved brief", companyId: "company", parentId: null })]);
    await mount(`/issues?q=${encodeURIComponent(query)}`);
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ q: query }), expect.anything());
    expect(host.querySelector('[data-task-id="server-match"]')).not.toBeNull();
  });
  it("still applies assignee filters to server search matches", async () => {
    mocks.list.mockResolvedValue([
      createIssue({ id: "chosen", companyId: "company", parentId: null, assigneeAgentId: "chosen-agent" }),
      createIssue({ id: "other", companyId: "company", parentId: null, assigneeAgentId: "other-agent" }),
    ]);
    await mount("/issues?q=comment-only&assignee=chosen-agent");
    expect([...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"))).toEqual(["chosen"]);
  });
  it("follows assignee URL changes and back/forward navigation without clearing other filters", async () => {
    mocks.list.mockResolvedValue([
      createIssue({ id: "first-high", companyId: "company", parentId: null, assigneeAgentId: "first", priority: "high" }),
      createIssue({ id: "second-high", companyId: "company", parentId: null, assigneeAgentId: "second", priority: "high" }),
      createIssue({ id: "second-low", companyId: "company", parentId: null, assigneeAgentId: "second", priority: "low" }),
    ]);
    function Navigation() {
      const navigate = useNavigate();
      return <><button onClick={() => navigate("/issues?assignee=second")}>Second assignee</button>
        <button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button>
        <button onClick={() => navigate("/issues")}>All assignees</button><CoordinatorTasks /></>;
    }
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?assignee=first"]}><Navigation /></MemoryRouter></QueryClientProvider>));
    const taskIds = () => [...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"));
    const click = (label: string) => flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === label)!.click());
    await vi.waitFor(() => expect(taskIds()).toEqual(["first-high"]));
    click("High priority");
    click("Second assignee");
    await vi.waitFor(() => expect(taskIds()).toEqual(["second-high"]));
    click("Back");
    await vi.waitFor(() => expect(taskIds()).toEqual(["first-high"]));
    click("Forward");
    await vi.waitFor(() => expect(taskIds()).toEqual(["second-high"]));
    click("All assignees");
    await vi.waitFor(() => expect(taskIds()).toEqual(["first-high", "second-high"]));
  });
  it.each(["clear", "change", "empty"])("persists %s URL-backed filters when leaving tasks and returning", async action => {
    mocks.list.mockResolvedValue([
      createIssue({ id: "first-done", companyId: "company", parentId: null, assigneeAgentId: "first", status: "done" }),
      createIssue({ id: "second-todo", companyId: "company", parentId: null, assigneeAgentId: "second", status: "todo" }),
      createIssue({ id: "third-todo", companyId: "company", parentId: null, assigneeAgentId: "third", status: "todo" }),
    ]);
    function Navigation() {
      const navigate = useNavigate();
      const location = useLocation();
      return <><output>{location.search}</output><button onClick={() => navigate("/task")}>Open task</button>
        <button onClick={() => navigate(-1)}>Back</button>{location.pathname === "/issues" ? <CoordinatorTasks /> : null}</>;
    }
    const search = action === "empty" ? "?assignee=missing&view=done&workspace=team" : "?assignee=first&view=done&workspace=team";
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/issues${search}`]}><Navigation /></MemoryRouter></QueryClientProvider>));
    const taskIds = () => [...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"));
    const click = (label: string) => flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === label)!.click());
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading tasks"));
    click(action === "empty" ? "Clear filters" : action === "clear" ? "Clear assignee and status" : "Change assignee and status");
    const expected = action === "change" ? ["second-todo"] : ["first-done", "second-todo", "third-todo"];
    await vi.waitFor(() => expect(taskIds()).toEqual(expected));
    await vi.waitFor(() => expect(host.querySelector("output")!.textContent).toContain("view=all"));
    const url = new URLSearchParams(host.querySelector("output")!.textContent!);
    expect(url.getAll("assignee")).toEqual(action === "change" ? ["first", "second"] : []);
    expect(url.getAll("status")).toEqual(action === "change" ? ["todo"] : []);
    expect(url.get("view")).toBe("all");
    expect(url.get("workspace")).toBe("team");
    click("Open task"); click("Back");
    await vi.waitFor(() => expect(taskIds()).toEqual(expected));
  });
  it("keeps local search for the hydrated Needs attention collection", async () => {
    await mount("/issues?view=needs_attention&q=no-matching-decision");
    expect(host.querySelectorAll("[data-task-id]")).toHaveLength(0);
    expect(host.textContent).toContain("No tasks match this view");
  });
  it("accepts canonical workspace links and their repeated values without fetching unrelated tasks", async () => {
    mocks.list.mockImplementation(async (_company, filters) => filters.workspaceId === "first" ? [
      createIssue({ id: "first-task", companyId: "company", parentId: null }),
    ] : filters.workspaceId === "second" ? [createIssue({ id: "second-task", companyId: "company", parentId: null })] : [
      createIssue({ id: "unrelated", companyId: "company", parentId: null }),
    ]);
    await mount("/issues?workspace=first&workspace=second&workspace=first");
    expect([...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"))).toEqual(["first-task", "second-task"]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    for (const workspaceId of ["first", "second"]) expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ workspaceId, offset: 0 }), expect.anything());
  });
  it("paginates repeated workspace links until every scoped source is exhausted and deduplicates shared tasks", async () => {
    const first = Array.from({ length: 200 }, (_, index) => createIssue({ id: `first-${index}`, companyId: "company", parentId: null }));
    const extra = createIssue({ id: "next-page", companyId: "company", parentId: null });
    const second = [first[0], ...["second-1", "second-2"].map(id => createIssue({ id, companyId: "company", parentId: null }))];
    mocks.list.mockImplementation(async (_company, filters) => filters.workspaceId === "first" ? filters.offset === 0 ? first : [extra] : filters.offset === 0 ? second : []);
    await mount("/issues?workspace=first&workspace=second");
    expect(host.querySelectorAll("[data-task-id]")).toHaveLength(202);
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Load more tasks")!.click());
    await vi.waitFor(() => expect(host.querySelectorAll("[data-task-id]")).toHaveLength(203));
    for (const workspaceId of ["first", "second"]) expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ workspaceId, offset: 200 }), expect.anything());
    expect(Array.from(host.querySelectorAll("button")).some(button => button.textContent === "Load more tasks")).toBe(false);
  });
  it("retains workspace scope when switching to Needs attention", async () => {
    const other = createIssue({ id: "other-workspace", companyId: "company", parentId: null, executionWorkspaceId: "other-workspace" });
    mocks.attention.mockResolvedValue({ taskIds: [pending.id, other.id] });
    mocks.list.mockResolvedValue([pending, other]);
    await mount(`/issues?view=needs_attention&workspace=${pending.executionWorkspaceId}`);
    expect([...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"))).toEqual([pending.id]);
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ ids: [pending.id, other.id], projection: "index" }), expect.anything());
  });
  it("retains authoritative participant scope in Needs attention, including tasks assigned to another agent", async () => {
    const participated = { ...pending, assigneeAgentId: "another-assignee" };
    const unrelated = createIssue({ id: "unrelated-agent", companyId: "company", parentId: null });
    mocks.attention.mockResolvedValue({ taskIds: [pending.id, unrelated.id] });
    mocks.list.mockImplementation(async (_company, filters) => filters.participantAgentId === "participant" && (!filters.ids || filters.ids[0] === pending.id) ? [participated] : []);
    await mount("/issues?participantAgentId=participant");
    flushSync(() => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Needs attention")!.click());
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ ids: [pending.id, unrelated.id], participantAgentId: "participant" }), expect.anything()));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading tasks"));
    expect([...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"))).toEqual([pending.id]);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
  it.each([["active", "in_progress"], ["backlog", "backlog"], ["done", "done"]] as const)("preserves the existing %s task preset", async (view, status) => {
    mocks.list.mockResolvedValue([createIssue({ id: "matching", companyId: "company", parentId: null, status }), createIssue({ id: "other", companyId: "company", parentId: null, status: "blocked" })]);
    await mount(`/issues?view=${view}`);
    const ids = [...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"));
    expect(ids).toEqual(view === "active" ? ["matching", "other"] : ["matching"]);
  });
  it("keeps inaccessible or failed pending tasks visible as an error, not a false all-clear", async () => {
    mocks.list.mockRejectedValue(new Error("Task unavailable"));
    await mount("/issues?view=needs_attention");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Task unavailable");
    expect(host.textContent).not.toContain("No tasks need a decision.");
  });
  it("does not report an all-clear when the index omits a pending task", async () => {
    mocks.list.mockResolvedValue([]);
    await mount("/issues?view=needs_attention");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Some tasks with pending decisions couldn’t load.");
    expect(host.textContent).not.toContain("No tasks need a decision.");
  });
});
