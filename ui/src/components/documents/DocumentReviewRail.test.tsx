// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DocumentReviewIndex,
  DocumentSuggestionWithComments,
} from "@paperclipai/shared";
import { DocumentReviewRail } from "./DocumentReviewRail";

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <p>{children}</p>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeSuggestion(overrides: Partial<DocumentSuggestionWithComments> = {}): DocumentSuggestionWithComments {
  return {
    id: "sug-1",
    companyId: "c1",
    issueId: "i1",
    documentId: "d1",
    documentKey: "spec",
    kind: "insertion",
    status: "pending",
    anchorState: "active",
    anchorConfidence: "exact",
    originalRevisionId: "rev-1",
    originalRevisionNumber: 1,
    currentRevisionId: "rev-1",
    currentRevisionNumber: 1,
    selectedText: "anchor",
    proposedText: "added text",
    insertionPosition: "after",
    prefixText: "",
    suffixText: "",
    normalizedStart: 0,
    normalizedEnd: 6,
    markdownStart: 0,
    markdownEnd: 6,
    anchorSelector: { quote: { exact: "anchor", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 6, markdownStart: 0, markdownEnd: 6 } },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    acceptedByAgentId: null,
    acceptedByUserId: null,
    acceptedAt: null,
    acceptedRevisionId: null,
    rejectedByAgentId: null,
    rejectedByUserId: null,
    rejectedAt: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    comments: [],
    ...overrides,
  };
}

function makeIndex(overrides: Partial<DocumentReviewIndex> = {}): DocumentReviewIndex {
  return {
    issueId: "i1",
    documentId: "d1",
    documentKey: "spec",
    latestRevisionId: "rev-1",
    latestRevisionNumber: 1,
    counts: {
      unresolved: 1,
      openAnchoredThreads: 1,
      openReviewThreads: 1,
      pendingSuggestions: 1,
      resolvedAnchoredThreads: 0,
      resolvedReviewThreads: 0,
      acceptedSuggestions: 0,
      rejectedSuggestions: 0,
      resolvedSuggestions: 0,
      staleAnchors: 0,
      orphanedAnchors: 0,
    },
    annotationThreads: [
      {
        id: "thread-1",
        companyId: "c1",
        issueId: "i1",
        documentId: "d1",
        documentKey: "spec",
        status: "open",
        anchorState: "active",
        anchorConfidence: "exact",
        originalRevisionId: "rev-1",
        originalRevisionNumber: 1,
        currentRevisionId: "rev-1",
        currentRevisionNumber: 1,
        selectedText: "anchored phrase",
        prefixText: "",
        suffixText: "",
        normalizedStart: 0,
        normalizedEnd: 5,
        markdownStart: 0,
        markdownEnd: 5,
        anchorSelector: { quote: { exact: "anchored phrase", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 5, markdownStart: 0, markdownEnd: 5 } },
        createdByAgentId: "agent-1",
        createdByUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        resolvedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        comments: [
          {
            id: "c1",
            companyId: "c1",
            threadId: "thread-1",
            issueId: "i1",
            documentId: "d1",
            body: "Worth being explicit here?",
            authorType: "agent",
            authorAgentId: "agent-1",
            authorUserId: null,
            createdByRunId: null,
            createdAt: new Date("2026-06-01T00:00:00Z"),
            updatedAt: new Date("2026-06-01T00:00:00Z"),
          },
        ],
      },
    ],
    reviewThreads: [
      {
        id: "overall-1",
        companyId: "c1",
        issueId: "i1",
        documentId: "d1",
        documentKey: "spec",
        status: "open",
        createdByAgentId: null,
        createdByUserId: "user-1",
        resolvedByAgentId: null,
        resolvedByUserId: null,
        resolvedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        comments: [
          {
            id: "rc1",
            companyId: "c1",
            threadId: "overall-1",
            issueId: "i1",
            documentId: "d1",
            body: "Overall this is close.",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            createdByRunId: null,
            createdAt: new Date("2026-06-01T00:00:00Z"),
            updatedAt: new Date("2026-06-01T00:00:00Z"),
          },
        ],
      },
    ],
    suggestions: [makeSuggestion()],
    ...overrides,
  };
}

const baseHandlers = {
  onReplyThread: vi.fn(),
  onToggleThreadResolved: vi.fn(),
  onAcceptSuggestion: vi.fn(),
  onRejectSuggestion: vi.fn(),
  onReplySuggestion: vi.fn(),
};

describe("DocumentReviewRail", () => {
  it("renders two tabs with counts and the overall + anchored comments", async () => {
    await act(() =>
      root.render(
        <DocumentReviewRail reviewIndex={makeIndex()} canReview canFinishReview latestRevisionId="rev-1" {...baseHandlers} />,
      ),
    );
    const commentsTab = container.querySelector('[data-testid="rail-tab-comments"]');
    const suggestionsTab = container.querySelector('[data-testid="rail-tab-suggestions"]');
    expect(commentsTab?.textContent).toContain("Comments (2)");
    expect(suggestionsTab?.textContent).toContain("Suggestions (1)");
    // Comments tab is default — shows overall + anchored.
    expect(container.textContent).toContain("Overall feedback");
    expect(container.textContent).toContain("anchored phrase");
  });

  it("renders a SuggestionCard on the Suggestions tab", async () => {
    await act(() =>
      root.render(
        <DocumentReviewRail
          reviewIndex={makeIndex()}
          canReview
          canFinishReview
          latestRevisionId="rev-1"
          initialTab="suggestions"
          {...baseHandlers}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="suggestion-card-sug-1"]')).not.toBeNull();
    expect(container.textContent).toContain("added text");
  });

  it("wires Resolve onto anchored (non-orphan) suggestion cards", async () => {
    // Regression: onResolveSuggestion was only wired on the orphaned-suggestion
    // branch, so Resolve never appeared on healthy/anchored cards where it's
    // most useful. Assert the non-orphan render path exposes it.
    await act(() =>
      root.render(
        <DocumentReviewRail
          reviewIndex={makeIndex()}
          canReview
          canFinishReview
          latestRevisionId="rev-1"
          initialTab="suggestions"
          onResolveSuggestion={vi.fn()}
          {...baseHandlers}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="suggestion-resolve-sug-1"]')).not.toBeNull();
  });

  it("pins orphaned anchors into a collapsible group when the orphan filter is on", async () => {
    const index = makeIndex({
      annotationThreads: [
        {
          ...makeIndex().annotationThreads[0],
          id: "thread-orphan",
          anchorState: "orphaned",
          selectedText: "lost anchor",
        },
      ],
    });
    await act(() =>
      root.render(
        <DocumentReviewRail reviewIndex={index} canReview canFinishReview latestRevisionId="rev-1" {...baseHandlers} />,
      ),
    );
    // Enable the orphaned filter chip.
    await act(() => container.querySelector<HTMLButtonElement>('[data-testid="rail-filter-orphaned"]')!.click());
    expect(container.querySelector('[data-testid="rail-orphan-group"]')).not.toBeNull();
    expect(container.textContent).toContain("Orphaned feedback (1)");
  });

  it("keeps Done reviewing keyboard-focusable but inert for read-only viewers", async () => {
    const onDoneReviewing = vi.fn();
    await act(() =>
      root.render(
        <DocumentReviewRail
          reviewIndex={makeIndex()}
          canReview={false}
          canFinishReview={false}
          latestRevisionId="rev-1"
          doneReviewingDisabledReason="You don't have edit access"
          onDoneReviewing={onDoneReviewing}
          {...baseHandlers}
        />,
      ),
    );
    const done = container.querySelector<HTMLButtonElement>('[data-testid="rail-done-reviewing"]');
    // aria-disabled (not the `disabled` attribute) so it stays in the tab order and can
    // surface the tooltip explaining *why* it's disabled to keyboard / screen-reader users.
    expect(done?.getAttribute("aria-disabled")).toBe("true");
    expect(done?.hasAttribute("disabled")).toBe(false);
    // ...but clicking it must not fire the handoff.
    await act(() => done!.click());
    expect(onDoneReviewing).not.toHaveBeenCalled();
  });

  it("shows a platform-aware comment hotkey in the empty state", async () => {
    const emptyIndex = makeIndex({
      counts: { ...makeIndex().counts, openAnchoredThreads: 0, openReviewThreads: 0, pendingSuggestions: 0 },
      annotationThreads: [],
      reviewThreads: [],
      suggestions: [],
    });
    const original = Object.getOwnPropertyDescriptor(window.navigator, "platform");

    // Windows/Linux reviewers should see the Ctrl spelling…
    Object.defineProperty(window.navigator, "platform", { value: "Win32", configurable: true });
    await act(() =>
      root.render(
        <DocumentReviewRail reviewIndex={emptyIndex} canReview canFinishReview latestRevisionId="rev-1" {...baseHandlers} />,
      ),
    );
    expect(container.querySelector('[data-testid="rail-empty"]')?.textContent).toContain("Ctrl+Shift+M");

    // …and macOS reviewers the ⌘ spelling.
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    await act(() =>
      root.render(
        <DocumentReviewRail reviewIndex={emptyIndex} canReview canFinishReview latestRevisionId="rev-1" {...baseHandlers} />,
      ),
    );
    expect(container.querySelector('[data-testid="rail-empty"]')?.textContent).toContain("⌘⇧M");

    if (original) Object.defineProperty(window.navigator, "platform", original);
  });

  it("fires the Done reviewing handler when the viewer can finish review", async () => {
    const onDoneReviewing = vi.fn();
    await act(() =>
      root.render(
        <DocumentReviewRail
          reviewIndex={makeIndex()}
          canReview
          canFinishReview
          latestRevisionId="rev-1"
          onDoneReviewing={onDoneReviewing}
          {...baseHandlers}
        />,
      ),
    );
    const done = container.querySelector<HTMLButtonElement>('[data-testid="rail-done-reviewing"]');
    expect(done?.getAttribute("aria-disabled")).toBeNull();
    await act(() => done!.click());
    expect(onDoneReviewing).toHaveBeenCalledTimes(1);
  });
});
