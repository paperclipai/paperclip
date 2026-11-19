// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_COLLECTION_PAINTED_EVENT } from "@/lib/issue-detail-preload-events";
import type { Issue } from "@paperclipai/shared";
import { seedIssueChatBootstrap, type IssueChatBootstrapEntry } from "@/lib/issueChatBootstrapCache";
import { queryKeys } from "@/lib/queryKeys";
import { CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS, resetIssueChatBootstrapsForTest } from "@/lib/issue-chat-bootstrap";
import { useRecentTaskOpenWarmup, type RecentTaskOpenWarmupTask } from "./useRecentTaskOpenWarmup";

const chatBootstrap = vi.hoisted(() => vi.fn());
vi.mock("@/api/issues", () => ({ issuesApi: { chatBootstrap } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tasks = (count: number): RecentTaskOpenWarmupTask[] =>
  Array.from({ length: count }, (_, index) => ({ id: `id-${index}`, identifier: `PAP-${index}` }));

function bootstrapItem(index: number, companyId = "company-1"): IssueChatBootstrapEntry {
  return {
    ref: `id-${index}`,
    issue: {
      id: `id-${index}`, identifier: `PAP-${index}`, companyId, title: `Task ${index}`, status: "todo", priority: "medium",
      workMode: "standard", projectId: null, parentId: null, description: null, assigneeAgentId: null, assigneeUserId: null,
      executionRunId: null, issueNumber: index, requestDepth: 0, createdAt: new Date(0), updatedAt: new Date(0),
    } as Issue,
    recentComments: { comments: [], hasMore: false, oldestCommentId: null, latestCommentId: null },
    commentInputFacts: [], recentActivity: [], recentRuns: [], interactions: [], attachments: [], liveRuns: [], activeRun: null,
  };
}

/** Long enough for two frames and the idle fallback timer. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let visibility: DocumentVisibilityState;

function Probe(props: { companyId: string | null; userId: string | null; tasks: RecentTaskOpenWarmupTask[]; navigationKey?: string }) {
  useRecentTaskOpenWarmup(props);
  return null;
}

function render(props: { companyId?: string | null; userId?: string | null; tasks: RecentTaskOpenWarmupTask[]; navigationKey?: string }) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe companyId={props.companyId === undefined ? "company-1" : props.companyId} userId={props.userId ?? "user-1"} tasks={props.tasks} navigationKey={props.navigationKey} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  resetIssueChatBootstrapsForTest();
  chatBootstrap.mockReset();
  chatBootstrap.mockImplementation(async (_companyId: string, ids: string[]) => ({
    items: ids.map((id) => bootstrapItem(Number(id.slice(3)))),
  }));
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("useRecentTaskOpenWarmup", () => {
  it("warms tasks added to Recents after the initial preload", async () => {
    render({ tasks: tasks(2) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);

    render({ tasks: [tasks(3)[2]!, ...tasks(2)] });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
    expect(chatBootstrap.mock.calls[1]![1]).toEqual(["id-2"]);
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-2"), "core"])).toMatchObject({ id: "id-2" });
  });

  it("reads the ten most recent tasks in one request once the page settles, and seeds them", async () => {
    render({ tasks: tasks(12) });
    expect(chatBootstrap).not.toHaveBeenCalled();
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    expect(chatBootstrap.mock.calls[0]![0]).toBe("company-1");
    expect(chatBootstrap.mock.calls[0]![1]).toEqual(tasks(10).map((task) => task.id));
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-3"), "core"])).toMatchObject({ id: "id-3" });
    render({ tasks: [...tasks(10)].reverse() });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
  });

  it("warms only tasks that move into the ten top rows", async () => {
    render({ tasks: tasks(12) });
    await settle();
    render({ tasks: [...tasks(12)].reverse() });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
    expect(chatBootstrap.mock.calls[1]![1]).toEqual(["id-11", "id-10"]);
  });

  it("does not consume a preload when rows change before the page settles", async () => {
    let finish!: (value: string) => void;
    void queryClient.fetchQuery({ queryKey: ["page-read"], queryFn: () => new Promise<string>((resolve) => { finish = resolve; }) });
    render({ tasks: tasks(2) });
    render({ tasks: [tasks(3)[2]!, ...tasks(2)] });
    await settle();
    expect(chatBootstrap).not.toHaveBeenCalled();
    await act(async () => { finish("done"); });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    expect(chatBootstrap.mock.calls[0]![1]).toEqual(["id-2", "id-0", "id-1"]);
  });

  it("allows a failed preload to retry on the next visit", async () => {
    chatBootstrap.mockRejectedValueOnce(new Error("offline"));
    render({ tasks: tasks(1) });
    await settle();
    act(() => root.unmount());
    root = createRoot(container);
    render({ tasks: tasks(1) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-0"), "core"])).toMatchObject({ id: "id-0" });
  });

  it("warms the task-detail code only when Recents has a task", async () => {
    const painted = vi.fn();
    window.addEventListener(TASK_COLLECTION_PAINTED_EVENT, painted);
    render({ tasks: [] });
    await settle();
    expect(painted).not.toHaveBeenCalled();
    expect(chatBootstrap).not.toHaveBeenCalled();
    render({ tasks: tasks(1) });
    await settle();
    expect(painted).toHaveBeenCalledTimes(1);
    window.removeEventListener(TASK_COLLECTION_PAINTED_EVENT, painted);
  });

  it("waits for the page's own reads to finish", async () => {
    let finish!: (value: string) => void;
    void queryClient.fetchQuery({ queryKey: ["page-read"], queryFn: () => new Promise<string>((resolve) => { finish = resolve; }) });
    render({ tasks: tasks(2) });
    await settle();
    expect(chatBootstrap).not.toHaveBeenCalled();
    await act(async () => { finish("done"); });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
  });

  it("makes no request while the tab is hidden", async () => {
    visibility = "hidden";
    render({ tasks: tasks(2) });
    await settle();
    expect(chatBootstrap).not.toHaveBeenCalled();
    visibility = "visible";
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
  });

  it("skips tasks whose first frame is cached and fresh, and makes no request when none is left", async () => {
    // A full first frame for two tasks (as an earlier open or preload leaves it)...
    seedIssueChatBootstrap(queryClient, bootstrapItem(0), { companyId: "company-1", requestedAt: Date.now() });
    seedIssueChatBootstrap(queryClient, bootstrapItem(1), { companyId: "company-1", requestedAt: Date.now() });
    // ...and a light warm (a brief hover) for the third, which is not a first frame.
    queryClient.setQueryData([...queryKeys.issues.detail("PAP-2"), "core"], bootstrapItem(2).issue);
    queryClient.setQueryData([...queryKeys.issues.comments("PAP-2"), "recent"], bootstrapItem(2).recentComments);
    render({ tasks: tasks(3) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    expect(chatBootstrap.mock.calls[0]![1]).toEqual(["id-2"]);

    // Now all three are cached in full: no request at all, even past the repeat window.
    resetIssueChatBootstrapsForTest();
    chatBootstrap.mockClear();
    act(() => root.unmount());
    root = createRoot(container);
    render({ tasks: tasks(3) });
    await settle();
    expect(chatBootstrap).not.toHaveBeenCalled();
  });

  it("sends nothing new on navigations within five minutes of a warm", async () => {
    render({ tasks: tasks(2), navigationKey: "/PAP/inbox" });
    await settle();
    render({ tasks: tasks(2), navigationKey: "/PAP/issues/PAP-9" });
    await settle();
    act(() => root.unmount());
    root = createRoot(container);
    render({ tasks: tasks(2), navigationKey: "/PAP/dashboard" });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
  });

  it("warms Recents again on a navigation once the earlier warm may have been dropped", async () => {
    // The sidebar stays mounted for hours; unread cache entries are dropped after five minutes.
    vi.useFakeTimers({ toFake: ["Date"] });
    render({ tasks: tasks(2), navigationKey: "/PAP/inbox" });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    queryClient.clear();
    vi.setSystemTime(Date.now() + CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS + 1);
    render({ tasks: tasks(2), navigationKey: "/PAP/dashboard" });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
    expect(chatBootstrap.mock.calls[1]![1]).toEqual(["id-0", "id-1"]);
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-1"), "core"])).toMatchObject({ id: "id-1" });
  });

  it("preloads the same task again for another account signed in within five minutes", async () => {
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    render({ tasks: tasks(1) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    // A sign-out clears the cached tasks; the next account opens the same task.
    queryClient.clear();
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    act(() => root.unmount());
    root = createRoot(container);
    render({ userId: "user-2", tasks: tasks(1) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-0"), "core"])).toMatchObject({ id: "id-0" });
  });

  it("never seeds another company's tasks", async () => {
    render({ tasks: tasks(1) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);

    // Another person in the same browser is their own scope.
    chatBootstrap.mockImplementationOnce(async () => ({ items: [bootstrapItem(5, "company-2")] }));
    render({ userId: "user-2", tasks: tasks(6).slice(5) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-5"), "core"])).toBeUndefined();
  });

  it("keeps an answer in flight when the sidebar unmounts, so a task opened meanwhile can use it", async () => {
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    render({ tasks: tasks(1) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    await act(async () => { answer({ items: [bootstrapItem(0)] }); });
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-0"), "core"])).toMatchObject({ id: "id-0" });
    root = createRoot(container);
  });

  it("drops the answer when the account changes before it arrives", async () => {
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    render({ tasks: tasks(1) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    act(() => { queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } }); });
    await act(async () => { answer({ items: [bootstrapItem(0)] }); });
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-0"), "core"])).toBeUndefined();
    expect(queryClient.getQueryData([...queryKeys.issues.detail("id-0"), "core"])).toBeUndefined();
  });
});
