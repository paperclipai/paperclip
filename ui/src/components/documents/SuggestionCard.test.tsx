// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSuggestionWithComments } from "@paperclipai/shared";
import { SuggestionCard } from "./SuggestionCard";

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
    kind: "substitution",
    status: "pending",
    anchorState: "active",
    anchorConfidence: "exact",
    originalRevisionId: "rev-1",
    originalRevisionNumber: 12,
    currentRevisionId: "rev-1",
    currentRevisionNumber: 12,
    selectedText: "old text",
    proposedText: "new text",
    insertionPosition: null,
    prefixText: "",
    suffixText: "",
    normalizedStart: 0,
    normalizedEnd: 8,
    markdownStart: 0,
    markdownEnd: 8,
    anchorSelector: { quote: { exact: "old text", prefix: "", suffix: "" }, position: { normalizedStart: 0, normalizedEnd: 8, markdownStart: 0, markdownEnd: 8 } },
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

describe("SuggestionCard", () => {
  it("renders the kind label and source/proposed diff", async () => {
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion()}
          latestRevisionId="rev-1"
          canReview
          onAccept={vi.fn()}
          onReject={vi.fn()}
          onReply={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain("Replace");
    expect(container.textContent).toContain("old text");
    expect(container.textContent).toContain("new text");
  });

  it("accepts a pending suggestion via the Accept button", async () => {
    const onAccept = vi.fn();
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion()}
          latestRevisionId="rev-1"
          canReview
          onAccept={onAccept}
          onReject={vi.fn()}
          onReply={vi.fn()}
        />,
      ),
    );
    const accept = container.querySelector<HTMLButtonElement>('[data-testid="suggestion-accept-sug-1"]');
    expect(accept).not.toBeNull();
    expect(accept?.disabled).toBe(false);
    await act(() => accept!.click());
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("gates Accept behind Needs rebase when the anchor revision lags the document", async () => {
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion({ currentRevisionId: "rev-1" })}
          latestRevisionId="rev-2"
          canReview
          onAccept={vi.fn()}
          onReject={vi.fn()}
          onReply={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="suggestion-needs-rebase-sug-1"]')).not.toBeNull();
    const accept = container.querySelector<HTMLButtonElement>('[data-testid="suggestion-accept-sug-1"]');
    expect(accept?.disabled).toBe(true);
  });

  it("requires a reason to reject", async () => {
    const onReject = vi.fn();
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion()}
          latestRevisionId="rev-1"
          canReview
          onAccept={vi.fn()}
          onReject={onReject}
          onReply={vi.fn()}
        />,
      ),
    );
    await act(() => container.querySelector<HTMLButtonElement>('[data-testid="suggestion-reject-toggle-sug-1"]')!.click());
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="suggestion-reject-confirm-sug-1"]');
    expect(confirm?.disabled).toBe(true); // no reason yet
    const reason = container.querySelector<HTMLTextAreaElement>('[data-testid="suggestion-reject-reason-sug-1"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(() => {
      setter.call(reason, "Not needed");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => container.querySelector<HTMLButtonElement>('[data-testid="suggestion-reject-confirm-sug-1"]')!.click());
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ id: "sug-1" }), "Not needed");
  });

  it("resolves a pending suggestion without a reason when onResolve is provided", async () => {
    const onResolve = vi.fn();
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion()}
          latestRevisionId="rev-1"
          canReview
          onAccept={vi.fn()}
          onReject={vi.fn()}
          onResolve={onResolve}
          onReply={vi.fn()}
        />,
      ),
    );
    const resolve = container.querySelector<HTMLButtonElement>('[data-testid="suggestion-resolve-sug-1"]');
    expect(resolve).not.toBeNull();
    await act(() => resolve!.click());
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ id: "sug-1" }));
  });

  it("omits Resolve when no handler is supplied", async () => {
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion()}
          latestRevisionId="rev-1"
          canReview
          onAccept={vi.fn()}
          onReject={vi.fn()}
          onReply={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="suggestion-resolve-sug-1"]')).toBeNull();
  });

  it("shows a Resolved badge and no actions for a resolved suggestion", async () => {
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion({ status: "resolved", resolvedAt: new Date() })}
          latestRevisionId="rev-1"
          canReview
          onAccept={vi.fn()}
          onReject={vi.fn()}
          onResolve={vi.fn()}
          onReply={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="suggestion-resolved-sug-1"]')).not.toBeNull();
    expect(container.textContent).toContain("Resolved");
    // Terminal status: accept/reject/resolve actions are gone.
    expect(container.querySelector('[data-testid="suggestion-accept-sug-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="suggestion-resolve-sug-1"]')).toBeNull();
  });

  it("hides review actions for read-only viewers", async () => {
    await act(() =>
      root.render(
        <SuggestionCard
          suggestion={makeSuggestion()}
          latestRevisionId="rev-1"
          canReview={false}
          onAccept={vi.fn()}
          onReject={vi.fn()}
          onReply={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="suggestion-accept-sug-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="suggestion-reply-sug-1"]')).toBeNull();
  });
});
