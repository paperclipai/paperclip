// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { IssueCommentFeedbackDelivery } from "@paperclipai/shared";

import {
  FEEDBACK_DELIVERY_RETRYING_REVEAL_MS,
  FEEDBACK_DELIVERY_TRANSIENT_SUCCESS_MS,
  FeedbackDeliveryFooterStatus,
  FeedbackDeliveryNotice,
  feedbackDeliveryAnchorId,
  feedbackDeliveryRetryErrorMessage,
  isIssueCommentFeedbackDelivery,
  useFeedbackDeliveryTransientSuccess,
} from "./FeedbackDeliveryState";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Synchronous act shim, matching the convention the other jsdom component
 * tests in this directory use (React 19 does not expose `act` from the entry
 * point this suite resolves).
 */
function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-14T18:00:00.000Z"));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<MemoryRouter>{element}</MemoryRouter>));
  return container;
}

function rerender(element: ReactElement) {
  act(() => root?.render(<MemoryRouter>{element}</MemoryRouter>));
  return container!;
}

/**
 * React schedules passive effects on a macrotask (MessageChannel), which fake
 * timers do not advance, so effect-driven state has to be awaited rather than
 * flushed synchronously.
 */
async function flushEffects() {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
  act(() => {});
}

function delivery(
  overrides: Partial<IssueCommentFeedbackDelivery> = {},
): IssueCommentFeedbackDelivery {
  return {
    state: "exhausted_needs_attention",
    sourceCommentId: "comment-1",
    attempt: 1,
    maxAttempts: 1,
    nextAttemptAt: null,
    lastAttemptAt: "2026-08-14T17:58:00.000Z",
    deliveredAt: null,
    targetRunId: "a1b2c3d4e5f6",
    targetRunAgentId: "agent-1",
    canRetry: true,
    retryInFlight: false,
    safeFailureReason: null,
    batchedCommentCount: 1,
    ...overrides,
  };
}

describe("FeedbackDeliveryFooterStatus", () => {
  it("stays quiet inside the Doherty window and appears after it", () => {
    const node = render(
      <FeedbackDeliveryFooterStatus delivery={delivery({ state: "retrying" })} />,
    );
    expect(node.querySelector("[data-testid='feedback-delivery-footer-status']")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    });
    const status = node.querySelector("[data-testid='feedback-delivery-footer-status']");
    expect(status?.textContent).toContain("Retrying feedback delivery");
    // Automatic recovery is still running: no operator control here.
    expect(node.querySelector("button")).toBeNull();
  });

  it("announces politely rather than as an alert", () => {
    const node = render(
      <FeedbackDeliveryFooterStatus delivery={delivery({ state: "retrying" })} />,
    );
    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    });
    const status = node.querySelector("[data-testid='feedback-delivery-footer-status']");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });

  it("prefers the countdown over the attempt tally", () => {
    const node = render(
      <FeedbackDeliveryFooterStatus
        delivery={delivery({
          state: "retrying",
          nextAttemptAt: "2026-08-14T18:00:12.000Z",
        })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    });
    const text = node.textContent ?? "";
    expect(text).toContain("Next attempt in");
    expect(text).not.toContain("Attempt");
  });

  it("falls back to the attempt tally when no countdown is known", () => {
    const node = render(
      <FeedbackDeliveryFooterStatus delivery={delivery({ state: "retrying", attempt: 0 })} />,
    );
    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    });
    expect(node.textContent).toContain("Attempt 1 of 2");
  });

  it("disables spin under reduced motion without dropping the text", () => {
    const node = render(
      <FeedbackDeliveryFooterStatus delivery={delivery({ state: "retrying" })} />,
    );
    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    });
    const icon = node.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("motion-reduce:animate-none");
    expect(node.textContent).toContain("Retrying feedback delivery");
  });

  it("renders nothing for a comment with no delivery state", () => {
    const node = render(<FeedbackDeliveryFooterStatus delivery={null} />);
    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    });
    expect(node.textContent).toBe("");
  });

  it("shows the transient success line only when asked", () => {
    const node = render(<FeedbackDeliveryFooterStatus delivery={null} showTransientSuccess />);
    const status = node.querySelector("[data-testid='feedback-delivery-footer-status']");
    expect(status?.getAttribute("data-state")).toBe("delivered_after_retry");
    expect(status?.textContent).toContain("Delivered after retry");
  });

  it("omits the run link when the viewer cannot open the run", () => {
    const node = render(
      <FeedbackDeliveryFooterStatus
        delivery={delivery({ state: "retrying", targetRunId: null, targetRunAgentId: null })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    });
    expect(node.querySelector("a")).toBeNull();
  });
});

function TransientProbe({ delivery: value }: { delivery: IssueCommentFeedbackDelivery | null }) {
  const show = useFeedbackDeliveryTransientSuccess(value);
  return <FeedbackDeliveryFooterStatus delivery={value} showTransientSuccess={show} />;
}

describe("useFeedbackDeliveryTransientSuccess", () => {
  it("confirms a watched recovery, then removes itself", async () => {
    const node = render(<TransientProbe delivery={delivery({ state: "retrying" })} />);
    rerender(<TransientProbe delivery={null} />);
    // The hook flips its flag in a passive effect, so the confirmation lands on
    // the render that effect schedules, not the one that dropped the state.
    await flushEffects();
    expect(node.textContent).toContain("Delivered after retry");

    act(() => {
      vi.advanceTimersByTime(FEEDBACK_DELIVERY_TRANSIENT_SUCCESS_MS);
    });
    await flushEffects();
    expect(node.textContent).toBe("");
  });

  it("leaves no trace for a delivery that was never visibly retrying", async () => {
    const node = render(<TransientProbe delivery={null} />);
    rerender(<TransientProbe delivery={null} />);
    await flushEffects();
    expect(node.textContent).toBe("");
  });

  it("does not celebrate a promotion to needs-attention", async () => {
    const node = render(<TransientProbe delivery={delivery({ state: "retrying" })} />);
    rerender(<TransientProbe delivery={delivery({ state: "exhausted_needs_attention" })} />);
    await flushEffects();
    expect(node.textContent).not.toContain("Delivered after retry");
  });
});

describe("FeedbackDeliveryNotice — exhausted", () => {
  it("states the problem in plain language with an alert announcement", () => {
    const node = render(<FeedbackDeliveryNotice delivery={delivery()} onRetry={() => {}} />);
    const banner = node.querySelector("[data-testid='feedback-delivery-exhausted']");
    expect(banner).not.toBeNull();
    expect(node.textContent).toContain("Feedback wasn't delivered");
    expect(node.textContent).toContain("Paperclip stopped retrying");
    expect(node.querySelector("[role='alert']")).not.toBeNull();
    for (const jargon of ["wake request", "adapter", "heartbeat"]) {
      expect(node.textContent?.toLowerCase()).not.toContain(jargon);
    }
  });

  it("offers retry plus an authorized run link, both large enough to tap", () => {
    const node = render(<FeedbackDeliveryNotice delivery={delivery()} onRetry={() => {}} />);
    const retry = node.querySelector("[data-testid='feedback-delivery-retry']");
    expect(retry?.textContent).toBe("Retry delivery");
    expect(retry?.getAttribute("class")).toContain("min-h-11");
    const runLink = node.querySelector("a[href='/agents/agent-1/runs/a1b2c3d4e5f6']");
    expect(runLink?.textContent).toBe("View run");
  });

  it("shortens the run reference to the first 8 characters", () => {
    const node = render(<FeedbackDeliveryNotice delivery={delivery()} />);
    expect(node.textContent).toContain("Run a1b2c3d4");
    expect(node.textContent).not.toContain("a1b2c3d4e5f6");
  });

  it("omits the run action entirely when no authorized route exists", () => {
    const node = render(
      <FeedbackDeliveryNotice
        delivery={delivery({ targetRunId: null, targetRunAgentId: null })}
        onRetry={() => {}}
      />,
    );
    expect([...node.querySelectorAll("a")].map((a) => a.textContent)).not.toContain("View run");
    // Recovery is still offered without it.
    expect(node.querySelector("[data-testid='feedback-delivery-retry']")).not.toBeNull();
  });

  it("calls back with the source comment id", () => {
    const onRetry = vi.fn();
    const node = render(<FeedbackDeliveryNotice delivery={delivery()} onRetry={onRetry} />);
    const retry = node.querySelector<HTMLButtonElement>(
      "[data-testid='feedback-delivery-retry']",
    );
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledWith("comment-1");
  });

  it("disables only the retry button while a retry is pending", () => {
    const node = render(
      <FeedbackDeliveryNotice delivery={delivery()} onRetry={() => {}} retryPending />,
    );
    const retry = node.querySelector<HTMLButtonElement>(
      "[data-testid='feedback-delivery-retry']",
    );
    expect(retry?.textContent).toBe("Retrying…");
    expect(retry?.disabled).toBe(true);
    const runLink = node.querySelector("a[href='/agents/agent-1/runs/a1b2c3d4e5f6']");
    expect(runLink).not.toBeNull();
  });

  it("keeps the pending affordance across a reload via retryInFlight", () => {
    const node = render(
      <FeedbackDeliveryNotice
        delivery={delivery({ retryInFlight: true, canRetry: false })}
        onRetry={() => {}}
      />,
    );
    const retry = node.querySelector<HTMLButtonElement>(
      "[data-testid='feedback-delivery-retry']",
    );
    expect(retry?.textContent).toBe("Retrying…");
    expect(retry?.disabled).toBe(true);
  });

  it("shows the retry failure inline, not only in a toast", () => {
    const node = render(
      <FeedbackDeliveryNotice delivery={delivery()} onRetry={() => {}} retryError />,
    );
    expect(node.querySelector("[data-testid='feedback-delivery-retry-error']")?.textContent).toContain(
      "Couldn't start another retry",
    );
    // The control is restored so the operator can act on that copy.
    expect(
      node.querySelector<HTMLButtonElement>("[data-testid='feedback-delivery-retry']")?.disabled,
    ).toBe(false);
  });

  it("shows an actionable paused-agent retry failure inline", () => {
    const message = feedbackDeliveryRetryErrorMessage({
      outcome: "no_invokable_assignee",
      reason: "paused",
      message: "server fallback",
      feedbackDelivery: delivery(),
    });
    const node = render(
      <FeedbackDeliveryNotice delivery={delivery()} onRetry={() => {}} retryError={message} />,
    );
    expect(node.querySelector("[data-testid='feedback-delivery-retry-error']")?.textContent).toBe(
      "The assigned agent is paused. Unpause the agent before retrying.",
    );
  });

  it("keeps missing-assignee retry guidance distinct from paused guidance", () => {
    expect(feedbackDeliveryRetryErrorMessage({
      outcome: "no_invokable_assignee",
      reason: "missing",
      message: "This delivery has no agent to retry against. Reassign the task first.",
      feedbackDelivery: delivery(),
    })).toBe("This delivery has no agent to retry against. Reassign the task first.");
  });

  it("hides retry from a viewer without the authority to trigger it", () => {
    const node = render(<FeedbackDeliveryNotice delivery={delivery({ canRetry: false })} />);
    expect(node.querySelector("[data-testid='feedback-delivery-retry']")).toBeNull();
    expect(node.textContent).toContain("Feedback wasn't delivered");
  });

  it("surfaces a safe failure reason when the server mapped one", () => {
    const node = render(
      <FeedbackDeliveryNotice
        delivery={delivery({ safeFailureReason: "The agent is over its budget." })}
      />,
    );
    expect(node.textContent).toContain("The agent is over its budget.");
  });

  it("rolls a batched obligation up in the banner copy", () => {
    const node = render(<FeedbackDeliveryNotice delivery={delivery({ batchedCommentCount: 3 })} />);
    expect(node.textContent).toContain("Covers 3 comments.");
  });

  it("exposes a focusable anchor for the attention deep link", () => {
    const node = render(<FeedbackDeliveryNotice delivery={delivery()} />);
    const anchor = node.querySelector(`#${feedbackDeliveryAnchorId("comment-1")}`);
    expect(anchor).not.toBeNull();
    expect(node.querySelector("[tabindex='-1']")?.textContent).toBe("Feedback wasn't delivered");
  });
});

describe("FeedbackDeliveryNotice — recovered", () => {
  const recovered = delivery({
    state: "recovered_after_attention",
    canRetry: false,
    deliveredAt: "2026-08-14T17:42:00.000Z",
  });

  it("replaces the warning with a historical delivered notice", () => {
    const node = render(<FeedbackDeliveryNotice delivery={recovered} />);
    expect(node.querySelector("[data-testid='feedback-delivery-recovered']")).not.toBeNull();
    expect(node.querySelector("[data-testid='feedback-delivery-exhausted']")).toBeNull();
    expect(node.textContent).toContain("Feedback delivered");
    expect(node.textContent).toContain("Recovered after delivery needed attention.");
  });

  it("offers no retry once delivery has recovered", () => {
    const node = render(<FeedbackDeliveryNotice delivery={recovered} onRetry={() => {}} />);
    expect(node.querySelector("[data-testid='feedback-delivery-retry']")).toBeNull();
  });

  it("keeps the authorized run reference for auditability", () => {
    const node = render(<FeedbackDeliveryNotice delivery={recovered} />);
    expect(node.querySelector("a[href='/agents/agent-1/runs/a1b2c3d4e5f6']")).not.toBeNull();
    expect(node.textContent).toContain("Run a1b2c3d4");
  });

  it("renders nothing for an unrecognized state", () => {
    const node = render(
      <FeedbackDeliveryNotice
        delivery={{ ...recovered, state: "retrying" }}
      />,
    );
    expect(node.textContent).toBe("");
  });
});

describe("isIssueCommentFeedbackDelivery", () => {
  it("accepts a well-formed projection", () => {
    expect(isIssueCommentFeedbackDelivery(delivery())).toBe(true);
  });

  it("rejects anything else, including a future unknown state", () => {
    expect(isIssueCommentFeedbackDelivery(null)).toBe(false);
    expect(isIssueCommentFeedbackDelivery("retrying")).toBe(false);
    expect(isIssueCommentFeedbackDelivery({ state: "retrying" })).toBe(false);
    expect(
      isIssueCommentFeedbackDelivery({ state: "quantum_delivered", sourceCommentId: "c" }),
    ).toBe(false);
  });
});
