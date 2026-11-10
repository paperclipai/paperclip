// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { MemoryRouter } from "@/lib/router";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { CoordinatorTasks } from "./CoordinatorTasks";
import { Issues } from "./Issues";
import { queryKeys } from "@/lib/queryKeys";
import { IssueFilterPanel } from "@/components/IssueFilterPanel";
import type { ComponentProps } from "react";
import type { TaskListSort } from "@/lib/task-list";
import { taskListViews, taskListViewStorageKey, type TaskListView } from "@/lib/task-list-views";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), attention: vi.fn(), breadcrumbs: vi.fn(), liveRuns: vi.fn(), localTrusted: false, realFilters: false, labels: [] as { id: string; name: string; color: string }[], identity: { userId: "person" as string | null, settled: true } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mocks.liveRuns } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: mocks.list, listCompact: mocks.list, get: mocks.get, listLabels: async () => mocks.labels, update: vi.fn() } }));
vi.mock("@/api/attention", () => ({ attentionApi: { taskIndex: mocks.attention } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => mocks.identity }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: mocks.identity.userId ?? (mocks.localTrusted ? "local-board" : null), loaded: mocks.identity.settled }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/components/TaskListToolbar", () => ({ TaskListToolbar: ({ filters, view, onViewChange, onLayoutChange }: { filters: Omit<ComponentProps<typeof IssueFilterPanel>, "onClear">; view: TaskListView; onViewChange: (view: TaskListView) => void; onLayoutChange: (layout: "list" | "board") => void }) => <>
  {mocks.realFilters ? <IssueFilterPanel {...filters} onClear={() => filters.onChange({ labels: [] })} /> : null}
  <span data-selected-view>{view}</span>
  {taskListViews.map(option => <button key={option.value} onClick={() => onViewChange(option.value)}>{option.label}</button>)}
  <button onClick={() => filters.onChange({ routineTasksOnly: true })}>Routine tasks</button>
  <button onClick={() => filters.onChange({ routineTasksOnly: false })}>Show other tasks</button>
  <button onClick={() => filters.onChange({ liveOnly: true })}>Live runs only</button>
  <button onClick={() => filters.onChange({ priorities: ["high"] })}>High priority</button>
  <button onClick={() => filters.onChange({ statuses: ["in_progress"] })}>In progress only</button>
  <button onClick={() => filters.onChange({ assignees: [], statuses: [] })}>Clear assignee and status</button>
  <button onClick={() => filters.onChange({ assignees: ["first", "second"], statuses: ["todo"] })}>Change assignee and status</button>
  <button onClick={() => onLayoutChange("board")}>Board view</button>
  <button onClick={() => onLayoutChange("list")}>List view</button>
</> }));
vi.mock("@/components/TaskList", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/TaskList")>(),
  TaskList: ({ items, emptyState, onSortChange }: { onSortChange?: (sort: TaskListSort) => void; items: { issue: { id: string; title: string }; assignee?: string | null }[]; emptyState: React.ReactNode }) =>
    <div><button onClick={() => onSortChange?.({ column: "taskId", direction: "descending" })}>Sort by task ID</button><output>{useLocation().search}</output>{items.length ? items.map(item => <p key={item.issue.id} data-task-id={item.issue.id} data-assignee={item.assignee}>{item.issue.title}</p>) : emptyState}</div>,
}));

describe("Coordinator tasks using the proposed table", () => {
  let root: Root, host: HTMLDivElement, client: QueryClient;
  const pending = createIssue({ id: "pending", companyId: "company", status: "todo", parentId: null, title: "Needs a channel answer" });
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    mocks.realFilters = false; mocks.labels = [];
    mocks.identity = { userId: "person", settled: true };
    mocks.localTrusted = false;
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
  it.each([
    { url: "/issues", view: "all", ids: ["parent", "mine", "assigned", "unrelated"] },
    { url: "/issues?view=inbox", view: "inbox", ids: ["parent", "mine", "assigned"] },
  ])("opens $url in $view, retaining parent context for Inbox", async ({ url, view, ids }) => {
    mocks.list.mockResolvedValue([
      createIssue({ id: "parent", companyId: "company", parentId: null, createdByUserId: "other" }),
      createIssue({ id: "mine", companyId: "company", parentId: "parent", createdByUserId: "person" }),
      createIssue({ id: "assigned", companyId: "company", parentId: null, assigneeUserId: "person" }),
      createIssue({ id: "unrelated", companyId: "company", parentId: null, createdByUserId: "other" }),
    ]);
    await mount(url);
    expect(host.querySelector("[data-selected-view]")?.textContent).toBe(view);
    expect([...host.querySelectorAll("[data-task-id]")].map(row => row.getAttribute("data-task-id"))).toEqual(ids);
    expect(host.querySelector("output")?.textContent).toBe(`?view=${view}`);
  });
  it.each(taskListViews)("remembers $label when leaving Tasks and returning without a view URL", async ({ value, label }) => {
    await mount("/issues");
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
    await vi.waitFor(() => expect(localStorage.getItem(taskListViewStorageKey("coordinator", "person"))).toBe(value));
    flushSync(() => root.unmount()); root = createRoot(host);
    await mount("/issues");
    expect(host.querySelector("[data-selected-view]")?.textContent).toBe(value);
  });
  it("uses the resolved local-board principal when no account session exists", async () => {
    mocks.realFilters = false; mocks.labels = [];
    mocks.identity = { userId: null, settled: true }; mocks.localTrusted = true;
    mocks.list.mockResolvedValue([createIssue({ id: "local", companyId: "company", parentId: null, createdByUserId: "local-board" })]);
    await mount("/issues");
    expect(host.querySelector('[data-task-id="local"]')).not.toBeNull();
    expect(localStorage.getItem(taskListViewStorageKey("coordinator", "local-board"))).toBe("all");
  });
  it.each(["inbox", "unread"])("keeps %s selected when applying a status filter", async view => {
    const mine = createIssue({ id: "mine-running", companyId: "company", parentId: null, createdByUserId: "person", status: "in_progress" });
    const other = createIssue({ id: "other-running", companyId: "company", parentId: null, createdByUserId: "other", status: "in_progress" });
    const todo = createIssue({ id: "todo", companyId: "company", parentId: null, createdByUserId: "person", status: "todo" });
    const read = createIssue({ id: "read-running", companyId: "company", parentId: null, createdByUserId: "other", status: "in_progress" });
    mocks.list.mockImplementation(async (_company, filters) => filters.unreadForUserId === "me" ? [mine, other, todo] : [mine, other, todo, read]);
    await mount(`/issues?view=${view}`);
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "In progress only")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toContain("status=in_progress"));
    expect(host.querySelector("[data-selected-view]")?.textContent).toBe(view);
    expect([...host.querySelectorAll("[data-task-id]")].map(row => row.getAttribute("data-task-id"))).toEqual(view === "inbox" ? [mine.id] : [mine.id, other.id]);
  });
  it("loads read ancestor chains as context for unread subtasks", async () => {
    const grandparent = createIssue({ id: "read-grandparent", companyId: "company", parentId: null });
    const parent = createIssue({ id: "read-parent", companyId: "company", parentId: grandparent.id });
    const child = createIssue({ id: "unread-child", companyId: "company", parentId: parent.id });
    mocks.list.mockImplementation(async (_company, filters) => filters.unreadForUserId === "me" ? [child] : [parent, grandparent].filter(issue => filters.ids?.includes(issue.id)));
    await mount("/issues?view=unread");
    await vi.waitFor(() => {
      expect([...host.querySelectorAll("[data-task-id]")].map(row => row.getAttribute("data-task-id"))).toEqual([child.id, parent.id, grandparent.id]);
    });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ projection: "index", ids: [parent.id] }), expect.anything());
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ projection: "index", ids: [grandparent.id] }), expect.anything());
  });
  it("queries the server's unread set and does not mark every task unread", async () => {
    const unread = createIssue({ id: "unread", companyId: "company", parentId: null });
    const read = createIssue({ id: "read", companyId: "company", parentId: null });
    mocks.list.mockImplementation(async (_company, filters) => filters.unreadForUserId === "me" ? [unread] : [unread, read]);
    await mount("/issues?view=unread");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ unreadForUserId: "me", projection: "index" }), expect.anything());
    expect([...host.querySelectorAll("[data-task-id]")].map(row => row.getAttribute("data-task-id"))).toEqual(["unread"]);
  });
  it("waits for the viewer identity before resolving their saved view", async () => {
    const key = taskListViewStorageKey("coordinator", "person");
    localStorage.setItem(key, "inbox");
    mocks.realFilters = false; mocks.labels = [];
    mocks.identity = { userId: null, settled: false };
    await mount("/issues");
    expect(localStorage.getItem(key)).toBe("inbox");
    mocks.realFilters = false; mocks.labels = [];
    mocks.identity = { userId: "person", settled: true };
    await mount("/issues");
    expect(host.querySelector("[data-selected-view]")?.textContent).toBe("inbox");
    expect(localStorage.getItem(key)).toBe("inbox");
  });
  it("loads the task index without descriptions or historical diagnostics", async () => {
    await mount("/issues?view=all");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ projection: "index", limit: 200 }), expect.anything());
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([
    ["local-board", "Board"],
    ["missing-user", "missi"],
  ])("keeps the shared human identity label when %s is absent from the directory", async (assigneeUserId, label) => {
    mocks.list.mockResolvedValue([createIssue({ id: "human-task", companyId: "company", parentId: null, assigneeAgentId: null, assigneeUserId })]);
    await mount("/issues");
    expect(host.querySelector('[data-task-id="human-task"]')?.getAttribute("data-assignee")).toBe(label);
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

  it("reads newest-first sorting and puts column sort clicks in the URL", async () => {
    mocks.list.mockResolvedValue([createIssue({ companyId: "company", parentId: null, originKind: "routine_execution" })]);
    await mount("/issues?view=all&originKind=routine_execution&sortField=created&sortDir=desc");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ sortField: "created", sortDir: "desc", originKind: "routine_execution", offset: 0 }), expect.anything());
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Sort by task ID")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toContain("sortField=taskId"));
    expect(Object.fromEntries(new URLSearchParams(host.querySelector("output")!.textContent!))).toMatchObject({
      view: "all", originKind: "routine_execution", sortField: "taskId", sortDir: "desc",
    });
  });

  it("keeps search relevance when a shared link selects creation order", async () => {
    await mount("/issues?sortField=created&sortDir=asc&q=report");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ q: "report", sortField: "updated", sortDir: "desc" }), expect.anything());
  });

  it.each(["updated&sortDir=asc", "created&sortDir=asc", "created&sortDir=desc"])("keeps recent board tasks when the list selects %s", async order => {
    const older = createIssue({ id: "older-task", companyId: "company", parentId: null, originKind: "routine_execution", title: "Older board task" });
    const recent = createIssue({ id: "recent-task", companyId: "company", parentId: null, originKind: "routine_execution", title: "Recently active board task" });
    mocks.list.mockImplementation(async (_company, filters) => filters.ids
      ? [older, recent].filter(issue => filters.ids.includes(issue.id))
      : filters.sortField === "updated" && filters.sortDir === "desc" ? [recent] : [older]);
    await mount(`/issues?sortField=${order}&originKind=routine_execution`);
    expect(host.textContent).toContain(older.title);
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Board view")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain(recent.title));
    expect(mocks.list.mock.calls.filter(call => call[1].projection === "index").at(-1)?.[1]).toMatchObject({ sortField: "updated", sortDir: "desc", originKind: "routine_execution", offset: 0 });
    expect(host.querySelector("output")?.textContent).toContain(`sortField=${order}`);
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "List view")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain(older.title));
  });

  it("requests dependency edges for shared workflow links", async () => {
    await mount("/issues?sortField=workflow&sortDir=asc");
    expect(mocks.list).toHaveBeenCalledWith("company", expect.objectContaining({ includeBlockedBy: true }), expect.anything());
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
    await mount("/issues?view=all");
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
    await mount("/issues?view=all");
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
    await mount("/issues?view=all");
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
  it("keeps a selected label and other URL filters after sorting and reloading", async () => {
    mocks.realFilters = true;
    mocks.labels = [{ id: "qa", name: "qa-task", color: "var(--accent)" }];
    mocks.list.mockResolvedValue([
      createIssue({ id: "qa-done", companyId: "company", parentId: null, assigneeAgentId: "chosen", status: "done", labelIds: ["qa"] }),
      createIssue({ id: "other-done", companyId: "company", parentId: null, assigneeAgentId: "chosen", status: "done", labelIds: [] }),
      createIssue({ id: "qa-todo", companyId: "company", parentId: null, assigneeAgentId: "chosen", status: "todo", labelIds: ["qa"] }),
    ]);
    await mount("/issues?view=all&status=done&assignee=chosen&workspace=team&q=release&keep=value");
    const taskIds = () => [...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"));
    const labelCheckbox = () => host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="qa-task"]')!;
    flushSync(() => labelCheckbox().click());
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-done"]));
    expect(labelCheckbox().getAttribute("aria-checked")).toBe("true");
    await vi.waitFor(() => expect(host.querySelector("output")!.textContent).toContain("label=qa"));
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Sort by task ID")!.click());
    await vi.waitFor(() => expect(host.querySelector("output")!.textContent).toContain("sortField=taskId"));
    const search = host.querySelector("output")!.textContent!;
    flushSync(() => root.unmount());
    root = createRoot(host);
    client.clear();
    await mount(`/issues${search}`);
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-done"]));
    expect(labelCheckbox().getAttribute("aria-checked")).toBe("true");
    const params = new URLSearchParams(host.querySelector("output")!.textContent!);
    expect(params.getAll("label")).toEqual(["qa"]);
    expect(Object.fromEntries(params)).toMatchObject({ view: "all", status: "done", assignee: "chosen", workspace: "team", q: "release", keep: "value", sortField: "taskId", sortDir: "desc" });
  });
  it("restores repeated labels from label-only links and follows history without clearing other filters", async () => {
    mocks.realFilters = true;
    mocks.labels = [{ id: "qa", name: "qa-task", color: "var(--accent)" }, { id: "review", name: "review-task", color: "var(--accent)" }];
    mocks.list.mockResolvedValue([
      createIssue({ id: "qa-high", companyId: "company", parentId: null, labelIds: ["qa"], priority: "high" }),
      createIssue({ id: "review-high", companyId: "company", parentId: null, labelIds: ["review"], priority: "high" }),
      createIssue({ id: "review-low", companyId: "company", parentId: null, labelIds: ["review"], priority: "low" }),
      createIssue({ id: "unlabeled", companyId: "company", parentId: null, labelIds: [], priority: "high" }),
    ]);
    function Navigation() {
      const navigate = useNavigate();
      return <><button onClick={() => navigate("/issues?view=all&label=review&keep=value")}>Review label</button>
        <button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button><CoordinatorTasks /></>;
    }
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?label=qa&label=review&keep=value"]}><Navigation /></MemoryRouter></QueryClientProvider>));
    const taskIds = () => [...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"));
    const click = (label: string) => flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high", "review-high", "review-low"]));
    expect(host.querySelector("[data-selected-view]")?.textContent).toBe("all");
    expect(host.querySelector('[role="checkbox"][aria-label="qa-task"]')?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="checkbox"][aria-label="review-task"]')?.getAttribute("aria-checked")).toBe("true");
    click("High priority"); click("Review label");
    await vi.waitFor(() => expect(taskIds()).toEqual(["review-high"]));
    click("Back");
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high", "review-high"]));
    click("Forward");
    await vi.waitFor(() => expect(taskIds()).toEqual(["review-high"]));
    flushSync(() => host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="qa-task"]')!.click());
    await vi.waitFor(() => expect(new URLSearchParams(host.querySelector("output")!.textContent!).getAll("label")).toEqual(["review", "qa"]));
    expect(taskIds()).toEqual(["qa-high", "review-high"]);
    flushSync(() => host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="qa-task"]')!.click());
    await vi.waitFor(() => expect(new URLSearchParams(host.querySelector("output")!.textContent!).getAll("label")).toEqual(["review"]));
    flushSync(() => host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="review-task"]')!.click());
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high", "review-high", "unlabeled"]));
    await vi.waitFor(() => expect(new URLSearchParams(host.querySelector("output")!.textContent!).getAll("label")).toEqual([]));
    const params = new URLSearchParams(host.querySelector("output")!.textContent!);
    expect(params.getAll("label")).toEqual([]);
    expect(params.get("keep")).toBe("value");
  });
  it("keeps unknown labels restrictive and removes them when clearing an empty collection", async () => {
    mocks.list.mockResolvedValue([createIssue({ id: "unlabeled", companyId: "company", parentId: null, labelIds: [] })]);
    await mount("/issues?view=all&label=missing&label=other-missing&keep=value&sortField=taskId&sortDir=asc");
    expect(host.querySelectorAll("[data-task-id]")).toHaveLength(0);
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Clear filters")!.click());
    await vi.waitFor(() => expect(host.querySelector('[data-task-id="unlabeled"]')).not.toBeNull());
    await vi.waitFor(() => expect(new URLSearchParams(host.querySelector("output")!.textContent!).getAll("label")).toEqual([]));
    const params = new URLSearchParams(host.querySelector("output")!.textContent!);
    expect(params.getAll("label")).toEqual([]);
    expect(Object.fromEntries(params)).toMatchObject({ view: "all", keep: "value", sortField: "taskId", sortDir: "asc" });
  });
  it.each(["mine", "blocked", "recent", "everything"])("keeps Coordinator and local filters/layout when the last label is removed from a legacy %s link", async view => {
    mocks.realFilters = true;
    mocks.labels = [{ id: "qa", name: "qa-task", color: "var(--accent)" }];
    mocks.list.mockResolvedValue([
      createIssue({ id: "qa-high", companyId: "company", parentId: null, labelIds: ["qa"], priority: "high" }),
      createIssue({ id: "qa-low", companyId: "company", parentId: null, labelIds: ["qa"], priority: "low" }),
      createIssue({ id: "unlabeled-high", companyId: "company", parentId: null, labelIds: [], priority: "high" }),
    ]);
    function CurrentRoute() {
      const location = useLocation(); const navigate = useNavigate();
      return <><output data-route>{location.pathname}{location.search}{location.hash}</output>
        <button onClick={() => navigate("/issues?view=all&label=qa&keep=value#saved")}>Restore label link</button>
        <button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></>;
    }
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/issues?view=${view}&label=qa&keep=value#saved`]}><CurrentRoute /><Routes>
      <Route path="/issues" element={<Issues />} /><Route path="/inbox/:tab" element={<p>Inbox owner</p>} />
    </Routes></MemoryRouter></QueryClientProvider>));
    const taskIds = () => [...host.querySelectorAll("[data-task-id]")].map(node => node.getAttribute("data-task-id"));
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high", "qa-low"]));
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "High priority")!.click());
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high"]));
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Board view")!.click());
    expect(host.querySelector<HTMLDivElement>(".design-task-list-panel")?.hidden).toBe(true);
    flushSync(() => host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="qa-task"]')!.click());
    await vi.waitFor(() => expect(host.querySelector("[data-route]")?.textContent).toBe("/issues?view=all&keep=value#saved"));
    expect(host.querySelector<HTMLDivElement>(".design-task-list-panel")?.hidden).toBe(true);
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high", "unlabeled-high"]));
    expect(host.textContent).not.toContain("Inbox owner");
    await vi.waitFor(() => expect(new URLSearchParams(host.querySelector(".design-task-list-panel output")!.textContent!).getAll("label")).toEqual([]));
    expect(Object.fromEntries(new URLSearchParams(host.querySelector(".design-task-list-panel output")!.textContent!))).toMatchObject({ view: "all", keep: "value" });
    flushSync(() => host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="qa-task"]')!.click());
    await vi.waitFor(() => expect(host.querySelector("[data-route]")?.textContent).toBe("/issues?view=all&keep=value&label=qa#saved"));
    expect(taskIds()).toEqual(["qa-high"]);
    flushSync(() => host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="qa-task"]')!.click());
    await vi.waitFor(() => expect(host.querySelector("[data-route]")?.textContent).toBe("/issues?view=all&keep=value#saved"));
    const click = (label: string) => flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
    click("Restore label link");
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high"]));
    click("Back");
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high", "unlabeled-high"]));
    click("Forward");
    await vi.waitFor(() => expect(taskIds()).toEqual(["qa-high"]));
    expect(host.querySelector<HTMLDivElement>(".design-task-list-panel")?.hidden).toBe(true);
    expect(host.querySelector("[data-route]")?.textContent).toBe("/issues?view=all&label=qa&keep=value#saved");
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
