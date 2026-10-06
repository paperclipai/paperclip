// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act } from "react";
import { i18n } from "@/i18n";
import { commentsToTaskChatItems } from "./task-chat-adapter";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
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

  it("localizes only proven system workspace notices and preserves expanded state and source content", async () => {
    const nextAction = "Check repository access and server load, then retry the task.";
    const body = `Paperclip could not prepare the workspace before the agent started. Automatic recovery could not continue. ${nextAction}`;
    const comment: IssueChatComment = {
      id: "workspace-system-notice", authorType: "system", body,
      companyId: "company-1", issueId: "issue-1", authorAgentId: null, authorUserId: null,
      presentation: { kind: "system_notice", title: "Workspace scan timed out", tone: "warning", detailsDefaultOpen: false },
      metadata: { version: 1, sourceRunId: "raw-source-run", sections: [{ rows: [
        { type: "key_value", label: "Failure code", value: "workspace_git_scan_timeout" },
        { type: "key_value", label: "Next action", value: nextAction },
      ] }] },
      createdAt: new Date("2026-09-16T12:00:00Z"),
      updatedAt: new Date("2026-09-16T12:00:00Z"),
    };
    const original = JSON.stringify(comment);
    const item = commentsToTaskChatItems([comment])[0] as TaskChatMessageItem;
    renderNotice(item);
    flushSync(() => toggleButton().click());
    const details = container.querySelector('[data-testid="task-chat-system-notice-details"]');
    try {
      for (const language of ["ru", "en", "ru"]) {
        await act(async () => { await i18n.changeLanguage(language); });
        expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelector('[data-testid="task-chat-system-notice-details"]')).toBe(details);
        expect(details?.textContent).toContain(language === "ru"
          ? "Проверьте доступ к репозиторию и нагрузку на сервер"
          : body);
        expect(details?.textContent).toContain("workspace_git_scan_timeout");
        if (language === "ru") expect(details?.textContent).not.toContain("Paperclip could not prepare");
        expect(JSON.stringify(comment)).toBe(original);
        expect(item.text).toBe(body);
      }
      for (const authorType of ["agent", "user"] as const) {
        const custom = commentsToTaskChatItems([{ ...comment, authorType }])[0] as TaskChatMessageItem;
        expect(custom.author).toBe("system");
        renderNotice(custom);
        expect(details?.textContent).toContain(body);
      }
    } finally {
      await act(async () => { await i18n.changeLanguage("en"); });
    }
  });

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

  it("shows workspace-ready comments as a compact row with expandable workspace metadata", () => {
    renderNotice({
      text: [
        "## Workspace Ready",
        "",
        "- Strategy: `git_worktree`",
        "- Branch: `fix/workspace-ready-notice`",
        "- CWD: `/worktrees/workspace-ready-notice`",
      ].join("\n"),
      presentation: {
        kind: "system_notice",
        tone: "info",
        title: "Workspace ready · fix/workspace-ready-notice",
        detailsDefaultOpen: false,
        density: "compact",
      },
      metadata: {
        version: 1,
        sections: [
          {
            title: "Workspace",
            rows: [
              { type: "key_value", label: "Strategy", value: "git_worktree" },
              {
                type: "key_value",
                label: "Branch",
                value: "fix/workspace-ready-notice",
              },
              { type: "key_value", label: "CWD", value: "/worktrees/workspace-ready-notice" },
            ],
          },
        ],
      },
    });

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="task-chat-system-notice"]')?.className).toContain(
      "items-start",
    );
    expect(toggleButton().textContent).toContain(
      "Workspace ready · fix/workspace-ready-notice",
    );
    expect(container.textContent).not.toContain("git_worktree");

    flushSync(() => toggleButton().click());

    const details = container.querySelector('[data-testid="task-chat-system-notice-details"]');
    expect(details?.textContent).toContain("Workspace");
    expect(details?.textContent?.match(/git_worktree/g)).toHaveLength(1);
    expect(details?.textContent?.match(/fix\/workspace-ready-notice/g)).toHaveLength(1);
    expect(details?.textContent).toContain("/worktrees/workspace-ready-notice");
    expect(details?.querySelector(".paperclip-markdown")).toBeNull();
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

  it("keeps workspace-ready events as a compact expandable notice", () => {
    renderNotice({
      text: "Workspace ready. The isolated worktree is available at `/tmp/paperclip/worktrees/PAP-91`.",
      metadata: null,
    });

    const button = toggleButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain("System update");
    expect(button.textContent).toContain("Workspace ready.");
    expect(button.querySelector("code")).toBeNull();
    expect(container.textContent).not.toContain("/tmp/paperclip/worktrees/PAP-91");

    flushSync(() => button.click());
    expect(container.textContent).toContain("/tmp/paperclip/worktrees/PAP-91");
  });

  it("ignores malformed metadata while preserving expandable raw detail", () => {
    renderNotice({
      text: "Workspace ready. Runtime metadata could not be decoded.",
      metadata: { version: 1, sections: "malformed" } as unknown as TaskChatMessageItem["metadata"],
    });

    expect(() => flushSync(() => toggleButton().click())).not.toThrow();
    expect(container.querySelector('[data-testid="task-chat-system-notice-details"]')).not.toBeNull();
    expect(container.textContent).toContain("Runtime metadata could not be decoded");
  });
});
