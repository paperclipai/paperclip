// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { IssueComment } from "@paperclipai/shared";
import { useConversationHistoryPages } from "./useConversationHistoryPages";
const api = vi.hoisted(() => ({ listComments: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: api }));

it("recovers deleted cursors in both the initial window and a fetched page", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.createElement("div"));
  const comment = (n: number) => ({ id: `comment-${n}`, createdAt: new Date(n * 1000) } as IssueComment);
  const recent = [1, 100, 101, 102].map(comment);
  api.listComments.mockImplementation(async (_ref, options) => {
    const cursor = Number(options.after?.split("-")[1] ?? 103);
    if ([100, 50].includes(cursor)) return [];
    return Array.from({ length: cursor }, (_, index) => comment(cursor - index - 1)).filter(row => !["comment-100", "comment-50"].includes(row.id)).slice(0, 50);
  });
  let current: ReturnType<typeof useConversationHistoryPages>;
  function Probe() { current = useConversationHistoryPages("chat", true, "comment-100", recent); return null; }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    expect(api.listComments).not.toHaveBeenCalled();
    await act(async () => { current!.load(); });
    await vi.waitFor(() => expect(current!.isSuccess).toBe(true));
    expect(current!.data?.pages[0].comments.at(-1)?.id).toBe("comment-49");
    expect(current!.hasNextPage).toBe(true);
    api.listComments.mockImplementation(async (_ref, options) => {
      const cursor = Number(options.after?.split("-")[1] ?? 103);
      if (cursor === 49) return [];
      return Array.from({ length: cursor }, (_, index) => comment(cursor - index - 1)).filter(row => !["comment-100", "comment-50", "comment-49"].includes(row.id)).slice(0, 50);
    });
    await act(async () => { await current!.load(); });
    await vi.waitFor(() => expect(current!.data?.pages).toHaveLength(2));
    expect(current!.data?.pages[1].comments.at(-1)?.id).toBe("comment-0");
    expect(current!.hasNextPage).toBe(false);
  } finally { await act(async () => root.unmount()); client.clear(); }
});
