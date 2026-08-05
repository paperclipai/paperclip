// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueReviewAttention } from "@paperclipai/shared";
import { IssueReviewPanel, type ReviewPanelIssue } from "./IssueReviewPanel";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";

const decideStalledReviewMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));

vi.mock("../api/issues", () => ({
  issuesApi: {
    decideStalledReview: decideStalledReviewMock,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  return result as T;
}

/** react-query dispatches the mutationFn on a microtask — let it settle. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          {element}
          <ToastViewport />
        </QueryClientProvider>
      </ToastProvider>,
    ),
  );
  return container;
}

function buildIssue(reviewAttention: IssueReviewAttention | undefined, status: ReviewPanelIssue["status"] = "in_review"): ReviewPanelIssue {
  return { id: "issue-1", companyId: "c1", status, reviewAttention };
}

const coveredAttention: IssueReviewAttention = {
  state: "covered",
  reason: "Review has a maintained action path.",
  paths: [
    {
      kind: "interaction",
      label: "Pending request confirmation",
      responder: "Board",
      since: "2026-08-02T00:00:00.000Z",
      ref: "interaction-1",
    },
    {
      kind: "human_reviewer",
      label: "Human reviewer",
      responder: "Dotta",
      since: "2026-08-02T00:00:00.000Z",
      ref: null,
    },
  ],
};

const stalledAttention: IssueReviewAttention = {
  state: "stalled",
  reason: "Issue is in review without a maintained action path.",
  paths: [],
};

describe("IssueReviewPanel", () => {
  it("renders nothing when the issue is not in review", () => {
    const el = render(<IssueReviewPanel issue={buildIssue(coveredAttention, "in_progress")} />);
    expect(el.querySelector('[data-testid="issue-review-panel"]')).toBeNull();
  });

  it("renders nothing when reviewAttention is absent (older payloads)", () => {
    const el = render(<IssueReviewPanel issue={buildIssue(undefined)} />);
    expect(el.querySelector('[data-testid="issue-review-panel"]')).toBeNull();
  });

  it("covered: names each maintained path with its responder and outcome hint", () => {
    const el = render(<IssueReviewPanel issue={buildIssue(coveredAttention)} />);
    const panel = el.querySelector('[data-testid="issue-review-panel"]');
    expect(panel?.getAttribute("data-review-state")).toBe("covered");
    expect(panel?.textContent).toContain("In review");
    expect(panel?.textContent).toContain("Pending request confirmation");
    expect(panel?.textContent).toContain("Board");
    expect(panel?.textContent).toContain("Human reviewer");
    expect(panel?.textContent).toContain("Dotta");
    // The outcome hint tells the operator what each verb does.
    expect(panel?.textContent).toContain("Approving marks this issue done");
    // Covered reviews do not expose the escape actions.
    expect(panel?.textContent).not.toContain("Send back to work");
  });

  it("stalled: shows the amber notice and the three review actions", () => {
    const el = render(<IssueReviewPanel issue={buildIssue(stalledAttention)} />);
    const panel = el.querySelector('[data-testid="issue-review-panel"]');
    expect(panel?.getAttribute("data-review-state")).toBe("stalled");
    expect(panel?.textContent).toContain("Nobody is reviewing this");
    expect(panel?.textContent).toContain("Approve");
    expect(panel?.textContent).toContain("Request changes");
    expect(panel?.textContent).toContain("Send back to work");
  });

  it("stalled: request-changes is disabled until a note is entered", () => {
    const el = render(<IssueReviewPanel issue={buildIssue(stalledAttention)} />);
    const requestChanges = el.querySelector<HTMLButtonElement>(
      '[data-testid="stalled-review-request-changes"]',
    );
    expect(requestChanges?.disabled).toBe(true);

    const note = el.querySelector<HTMLTextAreaElement>('[data-testid="stalled-review-note"]');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(note, "Please fix the failing test");
      note!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(requestChanges?.disabled).toBe(false);
  });

  it("stalled: approving posts approve to the decision endpoint", async () => {
    const el = render(<IssueReviewPanel issue={buildIssue(stalledAttention)} />);
    const approve = el.querySelector<HTMLButtonElement>('[data-testid="stalled-review-approve"]');
    act(() => approve!.click());
    await flushMicrotasks();
    expect(decideStalledReviewMock).toHaveBeenCalledWith("issue-1", {
      action: "approve",
      note: undefined,
    });
  });

  it("stalled: send-back forwards the typed note", async () => {
    const el = render(<IssueReviewPanel issue={buildIssue(stalledAttention)} />);
    const note = el.querySelector<HTMLTextAreaElement>('[data-testid="stalled-review-note"]');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(note, "Back to you");
      note!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendBack = el.querySelector<HTMLButtonElement>('[data-testid="stalled-review-send-back"]');
    act(() => sendBack!.click());
    await flushMicrotasks();
    expect(decideStalledReviewMock).toHaveBeenCalledWith("issue-1", {
      action: "send_back",
      note: "Back to you",
    });
  });
});
