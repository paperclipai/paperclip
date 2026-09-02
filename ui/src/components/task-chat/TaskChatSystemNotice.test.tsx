// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatSystemNotice } from "./TaskChatSystemNotice";
import type { TaskChatMessageItem } from "./task-chat-model";

describe("TaskChatSystemNotice (PAP-443)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  const recoveryBody =
    "Paperclip stopped before dispatching the adapter because required secret/env bindings are missing. " +
    "Latest retry failure: `configuration_incomplete`. Moving it to `blocked` with a source-scoped recovery action.";

  function renderNotice(
    overrides: Partial<TaskChatMessageItem> = {},
    props: {
      onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
      tryAgainNoLiveExecutionPathPending?: boolean;
    } = {},
  ) {
    const item: TaskChatMessageItem = {
      id: "sys-1",
      kind: "message",
      author: "system",
      text: recoveryBody,
      createdAtIso: new Date(Date.now() - 5 * 60_000).toISOString(),
      ...overrides,
    };
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatSystemNotice item={item} {...props} />
        </ThemeProvider>,
      ),
    );
  }

  function toggleButton() {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-system-notice"] button[aria-expanded]',
    )!;
  }

  it("collapses to a humanized one-liner with relative time and hides the raw body", () => {
    renderNotice();
    const button = toggleButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain("Task paused — a secret/config binding is missing");
    expect(button.textContent).toContain("5m ago");
    expect(container.textContent).not.toContain("source-scoped recovery action");
    expect(
      container.querySelector('[data-testid="task-chat-system-notice-details"]'),
    ).toBeNull();
  });

  it("expands on click to the full markdown body and metadata sections", () => {
    renderNotice({
      metadata: {
        version: 1,
        sections: [
          { title: "Failure", rows: [{ type: "code", label: "Code", code: "configuration_incomplete" }] },
        ],
      },
    });
    flushSync(() => toggleButton().click());

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    const details = container.querySelector('[data-testid="task-chat-system-notice-details"]');
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain("required secret/env bindings are missing");
    expect(details!.textContent).toContain("Failure");
    expect(details!.textContent).toContain("configuration_incomplete");

    // Collapses back — presentation-only fold, nothing lost.
    flushSync(() => toggleButton().click());
    expect(
      container.querySelector('[data-testid="task-chat-system-notice-details"]'),
    ).toBeNull();
  });

  it("links source-run metadata when the comment carries its run agent", () => {
    renderNotice({
      metadata: {
        version: 1,
        sections: [
          {
            title: "Run",
            rows: [{ type: "run_link", label: "Source run", runId: "run-1", agentId: "agent-1", title: "failed" }],
          },
        ],
      },
    });
    flushSync(() => toggleButton().click());

    expect(container.querySelector('a[href="/agents/agent-1/runs/run-1"]')).not.toBeNull();
  });

  it("respects presentation.detailsDefaultOpen", () => {
    renderNotice({
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Run recovery",
        detailsDefaultOpen: true,
      },
    });
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    expect(toggleButton().textContent).toContain("Run recovery");
    expect(
      container.querySelector('[data-testid="task-chat-system-notice-details"]'),
    ).not.toBeNull();
  });

  it("shows Try again while folded and invokes it without expanding the notice", async () => {
    const onTryAgain = vi.fn();
    renderNotice(
      {
        text: "Paperclip retried continuation, but it still has no live execution path.",
        presentation: {
          kind: "system_notice",
          tone: "danger",
          title: "No live execution path",
          detailsDefaultOpen: false,
        },
      },
      { onTryAgainNoLiveExecutionPath: onTryAgain },
    );

    const tryAgain = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-no-live-path-try-again"]',
    );
    expect(tryAgain?.textContent).toBe("Try again");
    flushSync(() => tryAgain!.click());
    await Promise.resolve();

    expect(onTryAgain).toHaveBeenCalledTimes(1);
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(
      container
        .querySelector('[data-testid="task-chat-system-notice"]')
        ?.classList.contains("items-start"),
    ).toBe(true);
  });

  it("moves Try again into the expanded notice footer", () => {
    renderNotice(
      {
        text: "Paperclip retried continuation, but it still has no live execution path.",
        presentation: {
          kind: "system_notice",
          tone: "danger",
          title: "No live execution path",
          detailsDefaultOpen: false,
        },
      },
      { onTryAgainNoLiveExecutionPath: vi.fn() },
    );

    flushSync(() => toggleButton().click());

    const details = container.querySelector(
      '[data-testid="task-chat-system-notice-details"]',
    );
    expect(
      details?.querySelector('[data-testid="task-chat-no-live-path-try-again"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="task-chat-no-live-path-try-again"]'),
    ).toHaveLength(1);
  });

  it("shows the pending state and omits Try again from unrelated notices", () => {
    renderNotice(
      {
        text: "Paperclip retried continuation, but it still has no live execution path.",
        presentation: {
          kind: "system_notice",
          tone: "danger",
          title: "No live execution path",
          detailsDefaultOpen: false,
        },
      },
      {
        onTryAgainNoLiveExecutionPath: vi.fn(),
        tryAgainNoLiveExecutionPathPending: true,
      },
    );

    const pending = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-no-live-path-try-again"]',
    );
    expect(pending?.disabled).toBe(true);
    expect(pending?.textContent).toBe("Trying again...");

    renderNotice(
      {
        text: recoveryBody,
        presentation: {
          kind: "system_notice",
          tone: "danger",
          title: "Configuration incomplete",
          detailsDefaultOpen: false,
        },
      },
      { onTryAgainNoLiveExecutionPath: vi.fn() },
    );
    expect(
      container.querySelector('[data-testid="task-chat-no-live-path-try-again"]'),
    ).toBeNull();
  });
});
