// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { onlineManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { createConnectivityStore, ConnectivityProvider, type ConnectivityStore } from "@/lib/connectivity";
import { createAppQueryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/queryKeys";
import { TaskCancellationProvider } from "@/context/TaskCancellationContext";
import {
  isReplayableIssueUpdate,
  mapIssuesInQueryData,
  useUpdateIssueMutation,
  type UpdateIssueMutation,
} from "./useUpdateIssueMutation";

const mockUpdate = vi.hoisted(() => vi.fn());
const mockGetCore = vi.hoisted(() => vi.fn());
const mockListAll = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({ issuesApi: { update: mockUpdate, getCore: mockGetCore, listAll: mockListAll } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issue = (overrides: Partial<Issue> = {}) =>
  ({ id: "issue-1", identifier: "PAP-1", companyId: "company-1", status: "todo", priority: "medium", ...overrides }) as Issue;

describe("mapIssuesInQueryData", () => {
  const refs = new Set(["PAP-1"]);
  const done = (value: Issue) => ({ ...value, status: "done" }) as Issue;

  it("updates a single issue, a list, and infinite pages", () => {
    expect(mapIssuesInQueryData(issue(), refs, done)).toMatchObject({ status: "done" });
    expect(mapIssuesInQueryData([issue(), issue({ id: "other", identifier: "PAP-2" })], refs, done)).toMatchObject([
      { status: "done" },
      { status: "todo" },
    ]);
    const pages = { pages: [[issue()], [issue({ id: "other", identifier: "PAP-2" })]], pageParams: [0, 1] };
    expect(mapIssuesInQueryData(pages, refs, done)).toMatchObject({ pages: [[{ status: "done" }], [{ status: "todo" }]], pageParams: [0, 1] });
  });

  it("keeps the same reference when nothing matches", () => {
    const list = [issue({ id: "other", identifier: "PAP-2" })];
    expect(mapIssuesInQueryData(list, refs, done)).toBe(list);
  });
});

describe("isReplayableIssueUpdate", () => {
  it("replays absolute fields only", () => {
    expect(isReplayableIssueUpdate({ status: "done", assigneeAgentId: null })).toBe(true);
    expect(isReplayableIssueUpdate({ comment: "hi" })).toBe(false);
    expect(isReplayableIssueUpdate({ interrupt: true })).toBe(false);
  });
});

describe("useUpdateIssueMutation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let store: ConnectivityStore;
  let current: UpdateIssueMutation;

  beforeEach(() => {
    mockUpdate.mockReset();
    mockGetCore.mockReset().mockImplementation(async (id: string) => issue({ id: id === "PAP-1" ? "issue-1" : id, parentId: id === "PAP-1" ? null : "issue-1" }));
    mockListAll.mockReset().mockResolvedValue([]);
    mockPushToast.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    store = createConnectivityStore({ probe: async () => ({ reachable: true }), browserOnline: true });
    queryClient = createAppQueryClient({ connectivity: store });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "account-a" } });
    queryClient.setQueryData(queryKeys.issues.detail("PAP-1"), issue());
    queryClient.setQueryData(queryKeys.issues.list("company-1"), [issue()]);
    queryClient.setQueryData(queryKeys.issues.listByProject("company-1", "project-1"), [issue()]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    queryClient.clear();
    onlineManager.setOnline(true);
  });

  function Harness() {
    current = useUpdateIssueMutation({ companyId: "company-1" });
    return null;
  }

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ConnectivityProvider store={store}>
            <TaskCancellationProvider><Harness /></TaskCancellationProvider>
          </ConnectivityProvider>
        </QueryClientProvider>,
      );
    });
  }

  const statusIn = (key: readonly unknown[]) => {
    const data = queryClient.getQueryData<Issue | Issue[]>(key);
    return Array.isArray(data) ? data[0]?.status : data?.status;
  };

  it("updates every cached copy optimistically", async () => {
    let resolve!: (value: unknown) => void;
    mockUpdate.mockReturnValue(new Promise((done) => { resolve = done; }));
    render();
    act(() => current.mutate({ id: "PAP-1", data: { status: "in_progress" } }));
    await act(async () => {});
    expect(statusIn(queryKeys.issues.detail("PAP-1"))).toBe("in_progress");
    expect(statusIn(queryKeys.issues.list("company-1"))).toBe("in_progress");
    expect(statusIn(queryKeys.issues.listByProject("company-1", "project-1"))).toBe("in_progress");
    await act(async () => resolve({ ...issue({ status: "in_progress" }), changes: {} }));
  });

  it("rolls back and shows readable copy instead of failing silently", async () => {
    mockUpdate.mockRejectedValue(new ApiError("not_allowed_here", 403, { error: "not_allowed_here" }));
    render();
    await act(async () => {
      current.mutate({ id: "PAP-1", data: { status: "done" } });
    });
    await act(async () => {});
    expect(statusIn(queryKeys.issues.detail("PAP-1"))).toBe("todo");
    expect(statusIn(queryKeys.issues.listByProject("company-1", "project-1"))).toBe("todo");
    expect(mockPushToast).toHaveBeenCalledWith({
      title: "Couldn't update the task",
      body: "You don’t have permission to do that.",
      tone: "error",
    });
  });

  it("pauses an absolute update during an outage and sends it once on reconnect", async () => {
    mockUpdate.mockResolvedValue({ ...issue({ priority: "high" }), changes: {} });
    onlineManager.setOnline(false);
    render();
    act(() => current.mutate({ id: "PAP-1", data: { priority: "high" } }));
    await act(async () => {});
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(statusIn(queryKeys.issues.detail("PAP-1"))).toBe("todo");
    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail("PAP-1"))?.priority).toBe("high");
    await act(async () => {
      onlineManager.setOnline(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith("PAP-1", { priority: "high" });
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it.each(["account-b", "account-a"])("never resumes an old update after sign-out and sign-in as %s", async (nextAccount) => {
    mockUpdate.mockResolvedValue({ ...issue({ priority: "high" }), changes: {} });
    onlineManager.setOnline(false);
    render();
    let pending!: Promise<unknown>;
    act(() => { pending = current.mutateAsync({ id: "PAP-1", data: { priority: "high" } }).catch(error => error); });
    await act(async () => {});
    expect(mockUpdate).not.toHaveBeenCalled();
    await act(async () => {
      await queryClient.resetQueries({ queryKey: queryKeys.auth.session });
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: nextAccount } });
      onlineManager.setOnline(true);
      await queryClient.resumePausedMutations();
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(await pending).toMatchObject({ name: "AbortError" });
  });

  it("sends a newer update only after an older one still retrying settles", async () => {
    let finishFirst!: (value: unknown) => void;
    mockUpdate
      .mockReturnValueOnce(new Promise((done) => { finishFirst = done; }))
      .mockResolvedValue({ ...issue({ status: "done" }), changes: {} });
    render();
    act(() => current.mutate({ id: "PAP-1", data: { status: "in_progress" } }));
    act(() => current.mutate({ id: "PAP-1", data: { status: "done" } }));
    await act(async () => {});
    // The newer change shows right away but waits to be sent.
    expect(statusIn(queryKeys.issues.detail("PAP-1"))).toBe("done");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishFirst({ ...issue({ status: "in_progress" }), changes: {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls.map((call) => call[1])).toEqual([{ status: "in_progress" }, { status: "done" }]);
  });

  it("rolls back only the failed update, keeping other tasks' changes", async () => {
    let failFirst!: (error: unknown) => void;
    mockUpdate.mockReturnValueOnce(new Promise((_, reject) => { failFirst = reject; }));
    queryClient.setQueryData(queryKeys.issues.list("company-1"), [issue(), issue({ id: "issue-2", identifier: "PAP-2" })]);
    render();
    act(() => current.mutate({ id: "PAP-1", data: { status: "in_progress" } }));
    await act(async () => {});
    // Another task changes while this update is still in flight.
    queryClient.setQueryData<Issue[]>(queryKeys.issues.list("company-1"), (rows) =>
      rows?.map((row) => (row.id === "issue-2" ? { ...row, status: "done" } : row)));
    await act(async () => failFirst(new ApiError("not_allowed_here", 403, { error: "not_allowed_here" })));
    const rows = queryClient.getQueryData<Issue[]>(queryKeys.issues.list("company-1"));
    expect(rows?.map((row) => row.status)).toEqual(["todo", "done"]);
  });

  it("keeps a newer edit to the same field when an older update fails", async () => {
    let failFirst!: (error: unknown) => void;
    mockUpdate
      .mockReturnValueOnce(new Promise((_, reject) => { failFirst = reject; }))
      .mockResolvedValue({ ...issue({ status: "done" }), changes: {} });
    render();
    act(() => current.mutate({ id: "PAP-1", data: { status: "in_progress" } }));
    act(() => current.mutate({ id: "PAP-1", data: { status: "done" } }));
    await act(async () => {});
    await act(async () => failFirst(new ApiError("not_allowed_here", 403, { error: "not_allowed_here" })));
    expect(statusIn(queryKeys.issues.detail("PAP-1"))).toBe("done");
  });

  it("does not hold an update to another task behind a pending one", async () => {
    let finishFirst!: (value: unknown) => void;
    mockUpdate
      .mockReturnValueOnce(new Promise((done) => { finishFirst = done; }))
      .mockResolvedValue({ ...issue({ id: "issue-2", identifier: "PAP-2" }), changes: {} });
    render();
    act(() => current.mutate({ id: "PAP-1", data: { status: "in_progress" } }));
    act(() => current.mutate({ id: "PAP-2", data: { status: "done" } }));
    await act(async () => {});
    expect(mockUpdate.mock.calls.map((call) => call[0])).toEqual(["PAP-1", "PAP-2"]);
    await act(async () => finishFirst({ ...issue({ status: "in_progress" }), changes: {} }));
  });

  const child = (id: string, status: Issue["status"] = "todo") => issue({ id, identifier: `TEST-${id}`, title: `Subtask ${id}`, status, parentId: "issue-1" });
  const choose = async (label: string) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find(button => button.textContent === label);
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    await act(async () => {});
  };

  it("lists active subtask titles and status icons without IDs or links before cancellation", async () => {
    const children = (["backlog", "todo", "in_progress", "in_review", "blocked"] as const)
      .map((status, index) => child(String(index + 1), status));
    children[4]!.parentId = children[0]!.id;
    mockGetCore.mockImplementation(async (id: string) => children.find(task => task.id === id) ?? issue());
    mockListAll.mockResolvedValue([...children, child("done", "done"), child("canceled", "cancelled")]);
    mockUpdate.mockImplementation(async (id: string) => issue({ id, status: "cancelled" }));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Cancel 5 active subtasks?");
    expect(dialog.querySelector('[data-slot="dialog-description"]')).toBeNull();
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
    expect(dialog.textContent).not.toContain("This task has");
    expect(dialog.textContent).not.toContain("Would you like to cancel");
    expect(dialog.querySelectorAll("li")).toHaveLength(5);
    expect(dialog.querySelectorAll("a")).toHaveLength(0);
    expect(Array.from(dialog.querySelectorAll('li [role="img"]'), icon => icon.getAttribute("aria-label")))
      .toEqual(["Backlog", "Todo", "In Progress", "In Review", "Blocked"]);
    for (const task of children) {
      expect(dialog.textContent).toContain(task.title);
      expect(dialog.textContent).not.toContain(task.identifier);
    }
    expect(dialog.textContent).not.toContain("Subtask done");
    expect(dialog.textContent).not.toContain("Subtask canceled");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(statusIn(queryKeys.issues.detail("PAP-1"))).toBe("todo");

    await choose("Cancel task and subtasks");
    expect(mockUpdate.mock.calls.map(call => call[0])).toEqual(["PAP-1", ...children.map(task => task.id)]);
    expect(mockUpdate.mock.calls.every(call => call[1].status === "cancelled")).toBe(true);
    expect(mockListAll).toHaveBeenCalledWith("company-1", expect.objectContaining({ descendantOf: "issue-1", includeAgentCreatedTasks: true }), { cache: "no-store" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows the visible status of waiting, monitoring, and covered subtasks", async () => {
    mockListAll.mockResolvedValue([
      { ...child("waiting", "in_review"), externalConversationState: "waiting" },
      { ...child("monitoring", "in_progress"), displayStatus: "monitoring" },
      { ...child("covered", "blocked"), blockerAttention: { state: "covered", reason: "active_child", coveredBlockerCount: 1 } },
    ]);
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(Array.from(dialog.querySelectorAll('li [role="img"]'), icon => icon.getAttribute("aria-label")))
      .toEqual(["Idle", "Monitoring", "Blocked · waiting on 1 active sub-task"]);
    expect(dialog.querySelector('li:last-child svg')?.getAttribute("style")).toContain("--status-task-icon-in_queue");
    expect(dialog.querySelectorAll("li button, li a")).toHaveLength(0);
    expect(dialog.textContent).not.toContain("TEST-");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("can cancel only the parent and leave its active subtasks unchanged", async () => {
    mockListAll.mockResolvedValue([child("1")]);
    mockUpdate.mockResolvedValue(issue({ status: "cancelled" }));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Cancel 1 active subtask?");
    await choose("Cancel task only");
    expect(mockUpdate).toHaveBeenCalledExactlyOnceWith("PAP-1", { status: "cancelled" });
  });

  it.each([
    { name: "active child", reason: "active_child", state: "covered", stalledIdentifier: null,
      label: "Blocked · waiting on 1 active sub-task", glyph: "in_queue" },
    { name: "active dependency", reason: "active_dependency", state: "covered", stalledIdentifier: null,
      label: "Blocked · covered by 1 active dependency", glyph: "in_queue" },
    { name: "stalled review", reason: "stalled_review", state: "stalled", stalledIdentifier: "TEST-998",
      label: "Blocked · review stalled with no clear next step", glyph: "blocked" },
    { name: "stalled review with fallback", reason: "stalled_review", state: "stalled", stalledIdentifier: null,
      label: "Blocked · review stalled with no clear next step", glyph: "blocked" },
  ] as const)("omits blocker task IDs from $name icon labels and hover titles", async ({ reason, state, stalledIdentifier, label, glyph }) => {
    const blockerAttention = Object.freeze({
      reason, state, unresolvedBlockerCount: 1, coveredBlockerCount: state === "covered" ? 1 : 0,
      stalledBlockerCount: state === "stalled" ? 1 : 0, attentionBlockerCount: 0,
      sampleBlockerIdentifier: "TEST-999", sampleStalledBlockerIdentifier: stalledIdentifier,
    });
    mockListAll.mockResolvedValue([{ ...child("blocked", "blocked"), blockerAttention }]);
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    const dialog = document.querySelector('[role="dialog"]')!;
    const icon = dialog.querySelector('li [role="img"]')!;
    expect(icon.getAttribute("aria-label")).toBe(label);
    expect(icon.querySelector("title")?.textContent).toBe(label);
    expect(icon.getAttribute("style")).toContain(`--status-task-icon-${glyph}`);
    expect(dialog.outerHTML).not.toContain("TEST-");
    expect(blockerAttention.sampleBlockerIdentifier).toBe("TEST-999");
    expect(blockerAttention.sampleStalledBlockerIdentifier).toBe(stalledIdentifier);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each(["slack", "speko"])("offers to cancel a waiting %s subtask", async (provider) => {
    const waiting = { ...child(provider, "in_review"), originKind: "chat_channel" as const, externalConversationState: "waiting" as const };
    mockListAll.mockResolvedValue([waiting]);
    mockGetCore.mockImplementation(async (id: string) => id === "PAP-1" ? issue() : waiting);
    mockUpdate.mockResolvedValue(issue({ status: "cancelled" }));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Cancel 1 active subtask?");
    await choose("Cancel task and subtasks");
    expect(mockUpdate.mock.calls.map(call => call[0])).toEqual(["PAP-1", provider]);
  });

  it("dismisses without changing tasks or reporting an error", async () => {
    mockListAll.mockResolvedValue([child("1")]);
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    await choose("Close");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPushToast).not.toHaveBeenCalled();
    expect(current.error).toBeNull();
    expect(statusIn(queryKeys.issues.detail("PAP-1"))).toBe("todo");
  });

  it.each([{ children: [] }, { children: [child("done", "done"), child("canceled", "cancelled")] }])("cancels without a modal when no subtasks are active", async ({ children }) => {
    mockListAll.mockResolvedValue(children);
    mockUpdate.mockResolvedValue(issue({ status: "cancelled" }));
    render();
    await act(async () => { await current.mutateAsync({ id: "PAP-1", data: { status: "cancelled" } }); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mockUpdate).toHaveBeenCalledExactlyOnceWith("PAP-1", { status: "cancelled" });
  });

  it("leaves completed, moved, and newly created subtasks alone after confirmation", async () => {
    mockListAll.mockResolvedValueOnce([child("1"), child("2"), child("3"), child("4")])
      .mockResolvedValueOnce([child("1", "done"), child("2"), child("4"), child("new")]);
    mockGetCore.mockImplementation(async (id: string) => id === "4" ? child("4", "done") : issue({ id, parentId: "issue-1" }));
    mockUpdate.mockResolvedValue(issue({ status: "cancelled" }));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    await choose("Cancel task and subtasks");
    expect(mockUpdate.mock.calls.map(call => call[0])).toEqual(["PAP-1", "2"]);
  });

  it("leaves a subtask alone when its latest read observes a different parent", async () => {
    mockListAll.mockResolvedValue([child("1"), child("2")]);
    mockGetCore.mockImplementation(async (id: string) => id === "PAP-1" ? issue() : child(id));
    mockUpdate.mockImplementation(async (id: string) => {
      if (id === "1") mockGetCore.mockImplementation(async (nextId: string) => ({ ...child(nextId), parentId: "another-root" }));
      return issue({ id, status: "cancelled" });
    });
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    await choose("Cancel task and subtasks");
    expect(mockGetCore).toHaveBeenCalledWith("2", { cache: "no-store" });
    expect(mockUpdate.mock.calls.map(call => call[0])).toEqual(["PAP-1", "1"]);
  });

  it("renders 500 subtasks once across unrelated renders and permits a parent-only choice", async () => {
    let titleReads = 0;
    const children = Array.from({ length: 500 }, (_, index) => {
      const task = child(String(index));
      Object.defineProperty(task, "title", { get() {
        if (++titleReads > 500) throw new Error("Subtask titles were scanned again without new data");
        return `Large subtask ${index}`;
      } });
      return task;
    });
    mockListAll.mockResolvedValue(children);
    mockUpdate.mockResolvedValue(issue({ status: "cancelled" }));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    for (let renderIndex = 0; renderIndex < 3; renderIndex++) render();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Cancel 500 active subtasks?");
    expect(dialog.querySelectorAll("li")).toHaveLength(500);
    expect(dialog.querySelectorAll('li [role="img"]')).toHaveLength(500);
    expect(dialog.querySelectorAll("a")).toHaveLength(0);
    expect(dialog.textContent).not.toContain("TEST-");
    expect(dialog.textContent).toContain("Cancel task only");
    expect(dialog.textContent).toContain("Cancel task and subtasks");
    expect(titleReads).toBe(500);
    expect(mockListAll).toHaveBeenCalledTimes(1);
    expect(mockGetCore).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    await choose("Cancel task only");
    expect(mockUpdate).toHaveBeenCalledExactlyOnceWith("PAP-1", { status: "cancelled" });
  });

  it("blocks cancellation when the subtask read fails", async () => {
    mockListAll.mockRejectedValue(new ApiError("forbidden", 403, null));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("reports partial failure and attempts the other confirmed subtasks", async () => {
    mockListAll.mockResolvedValue([child("1"), child("2")]);
    mockUpdate.mockImplementation(async (id: string) => {
      if (id === "1") throw new ApiError("forbidden", 403, null);
      return issue({ id, status: "cancelled" });
    });
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    await choose("Cancel task and subtasks");
    expect(mockUpdate.mock.calls.map(call => call[0])).toEqual(["PAP-1", "1", "2"]);
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("TEST-1"), tone: "error" }));
    expect(mockPushToast.mock.calls[0]![0].body).toContain("The task was canceled");
  });

  it("reports that the parent was canceled if refreshing the confirmed subtasks fails", async () => {
    mockListAll.mockResolvedValueOnce([child("1")]).mockRejectedValueOnce(new ApiError("unavailable", 503, null));
    mockUpdate.mockResolvedValue(issue({ status: "cancelled" }));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    await choose("Cancel task and subtasks");
    expect(mockUpdate).toHaveBeenCalledExactlyOnceWith("PAP-1", { status: "cancelled" });
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("The task was canceled, but its subtasks could not be refreshed") }));
  });

  it("does not cancel subtasks when canceling the parent fails", async () => {
    mockListAll.mockResolvedValue([child("1")]);
    mockUpdate.mockRejectedValue(new ApiError("forbidden", 403, null));
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    await choose("Cancel task and subtasks");
    expect(mockUpdate).toHaveBeenCalledExactlyOnceWith("PAP-1", { status: "cancelled" });
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("closes an account's pending confirmation when the account changes", async () => {
    mockListAll.mockResolvedValue([child("1")]);
    render();
    await act(async () => current.mutate({ id: "PAP-1", data: { status: "cancelled" } }));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => queryClient.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPushToast).not.toHaveBeenCalled();
  });
});
