// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_COLLECTION_PAINTED_EVENT } from "@/lib/issue-detail-preload-events";
import type { Issue } from "@paperclipai/shared";
import { seedIssueChatBootstrap, type IssueChatBootstrapEntry } from "@/lib/issueChatBootstrapCache";
import { queryKeys } from "@/lib/queryKeys";
import { resetRecentTaskChatPreloadForTests, useRecentTaskOpenWarmup, type RecentTaskOpenWarmupTask } from "./useRecentTaskOpenWarmup";

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

function Probe(props: { companyId: string | null; userId: string | null; tasks: RecentTaskOpenWarmupTask[] }) {
  useRecentTaskOpenWarmup(props);
  return null;
}

function render(props: { companyId?: string | null; userId?: string | null; tasks: RecentTaskOpenWarmupTask[] }) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe companyId={props.companyId === undefined ? "company-1" : props.companyId} userId={props.userId ?? "user-1"} tasks={props.tasks} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  resetRecentTaskChatPreloadForTests();
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
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("useRecentTaskOpenWarmup", () => {
  it("reads the ten most recent tasks in one request once the page settles, and seeds them", async () => {
    render({ tasks: tasks(12) });
    expect(chatBootstrap).not.toHaveBeenCalled();
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    expect(chatBootstrap.mock.calls[0]![0]).toBe("company-1");
    expect(chatBootstrap.mock.calls[0]![1]).toEqual(tasks(10).map((task) => task.id));
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-3"), "core"])).toMatchObject({ id: "id-3" });
    // Reordering or re-rendering Recents never starts a second request.
    render({ tasks: [...tasks(12)].reverse() });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
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

    // Now all three are cached in full: no request at all.
    resetRecentTaskChatPreloadForTests();
    chatBootstrap.mockClear();
    act(() => root.unmount());
    root = createRoot(container);
    render({ tasks: tasks(3) });
    await settle();
    expect(chatBootstrap).not.toHaveBeenCalled();
  });

  it("preloads once per account per page load and never seeds another company's tasks", async () => {
    render({ tasks: tasks(1) });
    await settle();
    act(() => root.unmount());
    root = createRoot(container);
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

  it("drops the answer when the sidebar unmounts before it arrives", async () => {
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce((_companyId: string, _ids: string[], options: { signal: AbortSignal }) => new Promise((resolve) => {
      answer = resolve;
      expect(options.signal.aborted).toBe(false);
    }));
    render({ tasks: tasks(1) });
    await settle();
    expect(chatBootstrap).toHaveBeenCalledTimes(1);
    const signal = (chatBootstrap.mock.calls[0]![2] as { signal: AbortSignal }).signal;
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => { answer({ items: [bootstrapItem(0)] }); });
    expect(queryClient.getQueryData([...queryKeys.issues.detail("PAP-0"), "core"])).toBeUndefined();
    root = createRoot(container);
  });
});
