// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DocumentAnnotationThreadWithComments } from "@paperclipai/shared";
import { ThreadCard } from "@/components/DocumentAnnotationPanel";
import { ThemeProvider } from "@/context/ThemeContext";
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

  it("preserves a queued reaction removal when a live-update refetch returns the earlier add", async () => {
    let finishAdd!: () => void;
    let finishRemove!: () => void;
    const doneSummary = { reaction: "done" as const, count: 1, reactedByMe: true, actors: [{ actorType: "user" as const, agentId: null, userId: null }] };
    setReaction
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { finishAdd = () => resolve({ id: "comment-1", reactions: [doneSummary] }); }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRemove = () => resolve({ id: "comment-1", reactions: [] }); }));

    const queryKey = ["issues", "document-annotations", "issue-1", "plan", "all"];
    let serverReactions: Array<typeof doneSummary> = [];
    const fetchAnnotations = vi.fn(async () => [{ id: "thread-1", comments: [{ id: "comment-1", reactions: serverReactions }] }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    let toggle!: ReturnType<typeof useDocumentAnnotationMutations>["toggleReaction"];
    function Harness() {
      useQuery({ queryKey, queryFn: fetchAnnotations });
      toggle = useDocumentAnnotationMutations({
        target: { kind: "issue", issueId: "issue-1", documentKey: "plan" },
        baseRevisionId: "rev-1",
        baseRevisionNumber: 1,
        pendingAnchor: null,
        onFocusThread: () => undefined,
      }).toggleReaction;
      return null;
    }

    const reactionsInCache = () =>
      (client.getQueryData(queryKey) as Array<{ comments: Array<{ reactions: Array<{ reaction: string; reactedByMe: boolean }> }> }>)[0]!
        .comments[0]!.reactions.map((entry) => [entry.reaction, entry.reactedByMe]);

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
    await vi.waitFor(() => expect(fetchAnnotations).toHaveBeenCalledTimes(1));

    await act(async () => {
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: true });
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: false });
    });
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(1));
    expect(reactionsInCache()).toEqual([]);

    // Simulate LiveUpdatesProvider invalidating the annotation query right after
    // the server commits the add, while the queued removal has not run yet.
    serverReactions = [doneSummary];
    await act(async () => {
      await client.invalidateQueries({ queryKey });
    });
    await vi.waitFor(() => expect(fetchAnnotations).toHaveBeenCalledTimes(2));
    expect(reactionsInCache()).toEqual([]);

    await act(async () => finishAdd());
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(2));
    expect(reactionsInCache()).toEqual([]);

    serverReactions = [];
    await act(async () => finishRemove());
    await vi.waitFor(() => expect(fetchAnnotations).toHaveBeenCalledTimes(3));
    expect(reactionsInCache()).toEqual([]);

    await act(async () => root.unmount());
    client.clear();
  });

  it("defers invalidation while a reaction write on another comment is still pending", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const doneSummary = { reaction: "done" as const, count: 1, reactedByMe: true, actors: [{ actorType: "user" as const, agentId: null, userId: null }] };
    const questionSummary = { reaction: "question" as const, count: 1, reactedByMe: true, actors: [{ actorType: "user" as const, agentId: null, userId: null }] };
    setReaction
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = () => resolve({ id: "comment-1", reactions: [doneSummary] }); }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = () => resolve({ id: "comment-2", reactions: [questionSummary] }); }));

    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const queryKey = ["issues", "document-annotations", "issue-1", "plan", "all"];
    client.setQueryData(queryKey, [{
      id: "thread-1",
      comments: [
        { id: "comment-1", reactions: [] },
        { id: "comment-2", reactions: [] },
      ],
    }]);
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

    const commentReactions = (idx: number) =>
      (client.getQueryData(queryKey) as Array<{ comments: Array<{ reactions: Array<{ reaction: string; reactedByMe: boolean }> }> }>)[0]!
        .comments[idx]!.reactions.map((entry) => [entry.reaction, entry.reactedByMe]);

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));

    await act(async () => {
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: true });
      toggle.mutate({ threadId: "thread-1", commentId: "comment-2", reaction: "question", present: true });
    });
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(2));
    invalidate.mockClear();

    await act(async () => finishFirst());
    expect(invalidate).not.toHaveBeenCalled();
    expect(commentReactions(0)).toEqual([["done", true]]);
    expect(commentReactions(1)).toEqual([["question", true]]);

    await act(async () => finishSecond());
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(commentReactions(0)).toEqual([["done", true]]);
    expect(commentReactions(1)).toEqual([["question", true]]);

    await act(async () => root.unmount());
    client.clear();
  });

  it("serializes reaction writes and preserves latest choice across panel remounts", async () => {
    let finishAdd!: () => void;
    let finishRemove!: () => void;
    const doneSummary = { reaction: "done" as const, count: 1, reactedByMe: true, actors: [{ actorType: "user" as const, agentId: null, userId: null }] };
    setReaction
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { finishAdd = () => resolve({ id: "comment-1", reactions: [doneSummary] }); }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRemove = () => resolve({ id: "comment-1", reactions: [] }); }));

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

    const reactionsInCache = () =>
      (client.getQueryData(queryKey) as Array<{ comments: Array<{ reactions: Array<{ reaction: string; reactedByMe: boolean }> }> }>)[0]!
        .comments[0]!.reactions.map((entry) => [entry.reaction, entry.reactedByMe]);

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<QueryClientProvider client={client}><Harness key="open-1" /></QueryClientProvider>));

    await act(async () => {
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: true });
    });
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(1));
    expect(reactionsInCache()).toEqual([["done", true]]);

    // Close and reopen the panel while the add request is still in flight.
    await act(async () => root.render(<QueryClientProvider client={client}><Harness key="open-2" /></QueryClientProvider>));
    await act(async () => {
      toggle.mutate({ threadId: "thread-1", commentId: "comment-1", reaction: "done", present: false });
    });

    // The DELETE must wait behind the in-flight PUT rather than racing ahead of it.
    expect(setReaction).toHaveBeenCalledTimes(1);
    expect(reactionsInCache()).toEqual([]);
    invalidate.mockClear();

    await act(async () => finishAdd());
    await vi.waitFor(() => expect(setReaction).toHaveBeenCalledTimes(2));
    expect(setReaction).toHaveBeenNthCalledWith(
      2,
      { kind: "issue", issueId: "issue-1", documentKey: "plan" },
      "thread-1",
      "comment-1",
      "done",
      false,
    );
    expect(reactionsInCache()).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => finishRemove());
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(reactionsInCache()).toEqual([]);

    await act(async () => root.unmount());
    client.clear();
  });
});

describe("ThreadCard comment reactions", () => {
  it("renders four one-tap reactions with counts, hover names, and toggle handlers while hiding optimistic comments", async () => {
    const onToggleReaction = vi.fn();
    const onFocus = vi.fn();
    const thread: DocumentAnnotationThreadWithComments = {
      id: "thread-1",
      companyId: "company-1",
      documentId: "doc-1",
      issueId: "issue-1",
      routineId: null,
      caseId: null,
      documentKey: "plan",
      status: "open",
      anchorState: "active",
      anchorConfidence: "exact",
      originalRevisionId: "rev-1",
      originalRevisionNumber: 1,
      currentRevisionId: "rev-1",
      currentRevisionNumber: 1,
      selectedText: "Ship it",
      prefixText: "",
      suffixText: "",
      normalizedStart: 0,
      normalizedEnd: 7,
      markdownStart: 0,
      markdownEnd: 7,
      anchorSelector: {
        quote: { exact: "Ship it", prefix: "", suffix: "" },
        position: { normalizedStart: 0, normalizedEnd: 7, markdownStart: 0, markdownEnd: 7 },
      },
      resolvedAt: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt: new Date("2026-05-12T10:00:00Z"),
      updatedAt: new Date("2026-05-12T10:01:00Z"),
      comments: [
        {
          id: "comment-1",
          companyId: "company-1",
          threadId: "thread-1",
          issueId: "issue-1",
          documentId: "doc-1",
          body: "Ready for review.",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          createdByRunId: "run-1",
          reactions: [
            {
              reaction: "done",
              count: 2,
              reactedByMe: true,
              actors: [
                { actorType: "user", agentId: null, userId: "user-1" },
                { actorType: "agent", agentId: "agent-1", userId: null },
              ],
            },
          ],
          createdAt: new Date("2026-05-12T10:00:00Z"),
          updatedAt: new Date("2026-05-12T10:00:00Z"),
        },
        {
          id: "optimistic-comment-2",
          companyId: "company-1",
          threadId: "thread-1",
          issueId: "issue-1",
          documentId: "doc-1",
          body: "Sending...",
          authorType: "user",
          authorAgentId: null,
          authorUserId: "user-1",
          createdByRunId: null,
          reactions: [],
          createdAt: new Date("2026-05-12T10:01:00Z"),
          updatedAt: new Date("2026-05-12T10:01:00Z"),
        },
      ],
    };

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ul>
            <ThreadCard
              thread={thread}
              expanded
              focusedCommentId={null}
              onFocus={onFocus}
              replyDraft=""
              onReplyChange={() => undefined}
              onSubmitReply={() => undefined}
              onResolveToggle={() => undefined}
              onCopyLink={() => undefined}
              pendingReply={false}
              pendingStatus={false}
              onToggleReaction={onToggleReaction}
              agentMap={new Map([["agent-1", { id: "agent-1", name: "Engineering" }]])}
            />
          </ul>
        </ThemeProvider>,
      );
    });

    const group = host.querySelector('[data-testid="document-annotation-reactions-comment-1"]') as HTMLElement;
    expect(group).not.toBeNull();
    expect(host.querySelector('[data-testid="document-annotation-reactions-optimistic-comment-2"]')).toBeNull();

    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((button) => button.dataset.reaction)).toEqual(["done", "check", "thumbs_up", "question"]);

    const done = buttons[0]!;
    expect(done.getAttribute("aria-pressed")).toBe("true");
    expect(done.textContent).toBe("✅2");
    expect(done.title).toBe("Done: user-1, Engineering");

    const question = buttons[3]!;
    expect(question.getAttribute("aria-pressed")).toBe("false");
    expect(question.textContent).toBe("❓");

    await act(async () => {
      question.click();
      done.click();
    });

    expect(onToggleReaction).toHaveBeenNthCalledWith(1, "comment-1", "question", true);
    expect(onToggleReaction).toHaveBeenNthCalledWith(2, "comment-1", "done", false);
    expect(onFocus).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
