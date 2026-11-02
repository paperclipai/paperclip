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
import {
  isReplayableIssueUpdate,
  mapIssuesInQueryData,
  useUpdateIssueMutation,
  type UpdateIssueMutation,
} from "./useUpdateIssueMutation";

const mockUpdate = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({ issuesApi: { update: mockUpdate } }));
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
            <Harness />
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
});
