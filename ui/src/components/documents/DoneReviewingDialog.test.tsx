// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentReviewIndexCounts } from "@paperclipai/shared";
import { DoneReviewingDialog, type DoneReviewingHandoff } from "./DoneReviewingDialog";

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

function counts(overrides: Partial<DocumentReviewIndexCounts> = {}): DocumentReviewIndexCounts {
  return {
    unresolved: 0,
    openAnchoredThreads: 2,
    openReviewThreads: 1,
    pendingSuggestions: 3,
    resolvedAnchoredThreads: 0,
    resolvedReviewThreads: 0,
    acceptedSuggestions: 0,
    rejectedSuggestions: 0,
    resolvedSuggestions: 0,
    staleAnchors: 1,
    orphanedAnchors: 4,
    ...overrides,
  };
}

// Radix Dialog portals into document.body, so query there rather than `container`.
function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DoneReviewingDialog", () => {
  it("renders the review summary counts", async () => {
    await act(() =>
      root.render(
        <DoneReviewingDialog open onOpenChange={() => {}} counts={counts()} onSubmit={() => {}} />,
      ),
    );
    expect(q('[data-testid="done-reviewing-dialog"]')).not.toBeNull();
    // Open comments = anchored(2) + review(1) = 3
    expect(q('[data-testid="done-reviewing-count-open-comments"]')?.textContent).toBe("3");
    expect(q('[data-testid="done-reviewing-count-suggestions"]')?.textContent).toBe("3");
    expect(q('[data-testid="done-reviewing-count-stale"]')?.textContent).toBe("1");
    expect(q('[data-testid="done-reviewing-count-orphaned"]')?.textContent).toBe("4");
  });

  it("submits with default toggles and the trimmed overall comment", async () => {
    const onSubmit = vi.fn<(h: DoneReviewingHandoff) => void>();
    await act(() =>
      root.render(<DoneReviewingDialog open onOpenChange={() => {}} counts={counts()} onSubmit={onSubmit} />),
    );

    const textarea = q<HTMLTextAreaElement>('[data-testid="done-reviewing-overall"]')!;
    await act(() => setTextarea(textarea, "  ship it  "));
    await act(() => q<HTMLButtonElement>('[data-testid="done-reviewing-submit"]')!.click());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual({
      overallComment: "ship it",
      commentOnLinkedIssue: true,
      wakeOwner: true,
    });
  });

  it("'Just close' closes without submitting", async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    await act(() =>
      root.render(
        <DoneReviewingDialog open onOpenChange={onOpenChange} counts={counts()} onSubmit={onSubmit} />,
      ),
    );
    await act(() => q<HTMLButtonElement>('[data-testid="done-reviewing-just-close"]')!.click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables the owner wake toggle and forces wakeOwner false when no owner", async () => {
    const onSubmit = vi.fn<(h: DoneReviewingHandoff) => void>();
    await act(() =>
      root.render(
        <DoneReviewingDialog
          open
          onOpenChange={() => {}}
          counts={counts()}
          canWakeOwner={false}
          onSubmit={onSubmit}
        />,
      ),
    );
    const wakeToggle = q<HTMLButtonElement>('[data-testid="done-reviewing-toggle-wake"]')!;
    expect(wakeToggle.disabled).toBe(true);
    expect(wakeToggle.getAttribute("aria-checked")).toBe("false");

    await act(() => q<HTMLButtonElement>('[data-testid="done-reviewing-submit"]')!.click());
    expect(onSubmit.mock.calls[0][0].wakeOwner).toBe(false);
  });

  it("lets the reviewer turn off the linked-issue comment", async () => {
    const onSubmit = vi.fn<(h: DoneReviewingHandoff) => void>();
    await act(() =>
      root.render(<DoneReviewingDialog open onOpenChange={() => {}} counts={counts()} onSubmit={onSubmit} />),
    );
    await act(() => q<HTMLButtonElement>('[data-testid="done-reviewing-toggle-comment"]')!.click());
    await act(() => q<HTMLButtonElement>('[data-testid="done-reviewing-submit"]')!.click());
    expect(onSubmit.mock.calls[0][0].commentOnLinkedIssue).toBe(false);
  });

  it("shows the clean-handoff hint when there is no open feedback", async () => {
    await act(() =>
      root.render(
        <DoneReviewingDialog
          open
          onOpenChange={() => {}}
          counts={counts({ openAnchoredThreads: 0, openReviewThreads: 0, pendingSuggestions: 0, staleAnchors: 0, orphanedAnchors: 0 })}
          onSubmit={() => {}}
        />,
      ),
    );
    expect(q('[data-testid="done-reviewing-clean"]')).not.toBeNull();
  });
});
