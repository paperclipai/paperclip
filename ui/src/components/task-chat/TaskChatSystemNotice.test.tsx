// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  function renderNotice(overrides: Partial<TaskChatMessageItem> = {}) {
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
          <TaskChatSystemNotice item={item} />
        </ThemeProvider>,
      ),
    );
  }

  function toggleButton() {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-system-notice"] button',
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
});
