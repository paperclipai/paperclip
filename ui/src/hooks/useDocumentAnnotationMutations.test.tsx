// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applyOptimisticReaction, useDocumentAnnotationMutations } from "./useDocumentAnnotationMutations";

const setReaction = vi.hoisted(() => vi.fn());
vi.mock("@/api/document-annotations", () => ({ documentAnnotationsApi: { setReactionForTarget: setReaction } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn(() => new Promise(() => {})) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("applyOptimisticReaction", () => {
  it("adds my reaction in the fixed reaction order", () => {
    const next = applyOptimisticReaction(
      [{ reaction: "question", count: 1, reactedByMe: false, actors: [{ actorType: "agent", agentId: "agent-1", userId: null }] }],
      "done",
      true,
      "user-1",
    );
    expect(next.map((entry) => [entry.reaction, entry.count, entry.reactedByMe])).toEqual([
      ["done", 1, true],
      ["question", 1, false],
    ]);
  });

  it("removes my reaction and drops an empty summary", () => {
    const next = applyOptimisticReaction(
      [{ reaction: "thumbs_up", count: 1, reactedByMe: true, actors: [{ actorType: "user", agentId: null, userId: "user-1" }] }],
      "thumbs_up",
      false,
      "user-1",
    );
    expect(next).toEqual([]);
  });

  it("leaves the list unchanged when the toggle repeats my current state", () => {
    const current = [{ reaction: "check" as const, count: 1, reactedByMe: true, actors: [] }];
    expect(applyOptimisticReaction(current, "check", true, "user-1")).toBe(current);
  });
});

describe("toggleReaction", () => {
  it("sends a remove only after the add for the same reaction finishes", async () => {
    let finishAdd!: () => void;
    setReaction
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { finishAdd = () => resolve({ id: "comment-1", reactions: [] }); }))
      .mockResolvedValueOnce({ id: "comment-1", reactions: [] });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let toggle!: ReturnType<typeof useDocumentAnnotationMutations>["toggleReaction"];
    function Harness() {
      toggle = useDocumentAnnotationMutations({
        target: { kind: "issue", issueId: "issue-1", documentKey: "plan" },
        baseRevisionId: "rev-1",
        baseRevisionNumber: 1,
        pendingAnchor: null,
        onFocusThread: () => undefined,
      }).toggleReaction;
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));

    await act(async () => {
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: true });
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: false });
    });
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(1));
    expect(setReaction).toHaveBeenLastCalledWith(expect.anything(), "thread-1", "comment-1", "done", true);

    await act(async () => finishAdd());
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(2));
    expect(setReaction).toHaveBeenLastCalledWith(expect.anything(), "thread-1", "comment-1", "done", false);

    await act(async () => root.unmount());
    client.clear();
  });

  it("keeps a pending reaction when another reaction on the same comment finishes first", async () => {
    let finishDone!: () => void;
    let finishQuestion!: () => void;
    const doneSummary = { reaction: "done" as const, count: 1, reactedByMe: true, actors: [{ actorType: "user" as const, agentId: null, userId: null }] };
    const questionSummary = { reaction: "question" as const, count: 1, reactedByMe: true, actors: [{ actorType: "user" as const, agentId: null, userId: null }] };
    setReaction
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { finishDone = () => resolve({ id: "comment-1", reactions: [doneSummary] }); }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishQuestion = () => resolve({ id: "comment-1", reactions: [doneSummary, questionSummary] }); }));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const queryKey = ["issues", "document-annotations", "issue-1", "plan", "all"];
    client.setQueryData(queryKey, [{ id: "thread-1", comments: [{ id: "comment-1", reactions: [] }] }]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let toggle!: ReturnType<typeof useDocumentAnnotationMutations>["toggleReaction"];
    function Harness() {
      toggle = useDocumentAnnotationMutations({
        target: { kind: "issue", issueId: "issue-1", documentKey: "plan" },
        baseRevisionId: "rev-1",
        baseRevisionNumber: 1,
        pendingAnchor: null,
        onFocusThread: () => undefined,
      }).toggleReaction;
      return null;
    }
    const reactionsInCache = () => (client.getQueryData(queryKey) as Array<{ comments: Array<{ reactions: Array<{ reaction: string; reactedByMe: boolean }> }> }>)[0].comments[0].reactions
      .map((entry) => [entry.reaction, entry.reactedByMe]);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));

    await act(async () => {
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: true });
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "question", present: true });
    });
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(2));
    invalidate.mockClear();

    await act(async () => finishDone());
    expect(reactionsInCache()).toEqual([["done", true], ["question", true]]);
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => finishQuestion());
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(reactionsInCache()).toEqual([["done", true], ["question", true]]);

    await act(async () => root.unmount());
    client.clear();
  });
});
