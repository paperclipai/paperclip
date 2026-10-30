// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { IssueComment } from "@paperclipai/shared";
import { useIssueHistoryWindow } from "./useIssueHistoryWindow";
import { queryKeys } from "@/lib/queryKeys";
const api = vi.hoisted(() => ({ recentComments: vi.fn(), listComments: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: api }));

it.each([true, false])("retains a burst larger than the preview window (initially empty: %s)", async (empty) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const comment = (n: number) => ({ id: `comment-${n}`, createdAt: new Date(n * 1000), body: `Message ${n}` } as IssueComment);
  let current: ReturnType<typeof useIssueHistoryWindow>;
  function Probe() { current = useIssueHistoryWindow("one", false); return <span>{current.recent.data?.comments.length}</span>; }
  api.recentComments.mockResolvedValue({ comments: empty ? [] : [comment(0)], latestCommentId: empty ? null : "comment-0", hasMore: !empty });
  api.listComments.mockReset();
  const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
    for (let i = 0; i < 20 && !current!.recent.isSuccess; i++) await wait();
    expect(current!.recent.isSuccess).toBe(true);
    api.recentComments.mockResolvedValue({ comments: [comment(58),comment(59),comment(60)], latestCommentId: "comment-60", hasMore: true });
    api.listComments.mockResolvedValueOnce(Array.from({length:50},(_,i)=>comment(i+1))).mockResolvedValueOnce(Array.from({length:10},(_,i)=>comment(i+51)));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.comments("one") }); });
    for (let i = 0; i < 20 && current!.recent.data?.latestCommentId !== "comment-60"; i++) await wait();
    expect(current!.recent.error).toBeNull();
    expect(current!.recent.data?.comments).toHaveLength(empty ? 60 : 61);
    expect(current!.recent.data?.hasMore).toBe(!empty);
    expect(api.listComments).toHaveBeenCalledTimes(2);
    expect(new Set(current!.recent.data?.comments.map(c=>c.id)).size).toBe(empty ? 60 : 61);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

it.each([true, false])("catches up after canceled input and a reply burst (earlier anchor survives: %s)", async (earlierAnchorSurvives) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.createElement("div"));
  const comment = (n: number) => ({ id: `comment-${n}`, createdAt: new Date(n * 1000), body: `Message ${n}` } as IssueComment);
  let current: ReturnType<typeof useIssueHistoryWindow>;
  function Probe() {
    current = useIssueHistoryWindow("one", false);
    return <span>{current.recent.data?.comments.length}</span>;
  }
  api.recentComments.mockResolvedValue({ comments: [comment(0), comment(1)], latestCommentId: "comment-1", hasMore: true });
  api.listComments.mockReset();
  const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    for (let i = 0; i < 20 && !current!.recent.isSuccess; i++) await wait();
    expect(current!.recent.isSuccess).toBe(true);
    api.recentComments.mockResolvedValue({ comments: [58, 59, 60, 61].map(comment), latestCommentId: "comment-61", hasMore: true });
    api.listComments.mockImplementation(async (_issue, options) => {
      if (options.after === "comment-1") return []; // Canceled queued input.
      if (options.after === "comment-0" && !earlierAnchorSurvives) return [];
      const start = options.after === "comment-51" ? 52 : 2;
      return Array.from({ length: Math.min(50, 62 - start) }, (_, i) => comment(start + i));
    });
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.comments("one") }); });
    for (let i = 0; i < 20 && current!.recent.data?.latestCommentId !== "comment-61"; i++) await wait();
    expect(current!.recent.error).toBeNull();
    expect(current!.recent.data?.comments.filter(c => Number(c.id.split("-")[1]) >= 2).map(c => c.id))
      .toEqual(Array.from({ length: 60 }, (_, i) => `comment-${i + 2}`));
    expect(current!.recent.data?.latestCommentId).toBe("comment-61");
    expect(api.listComments).toHaveBeenCalledTimes(earlierAnchorSurvives ? 3 : 4);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
