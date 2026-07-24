// @vitest-environment jsdom

import { act, createRef, forwardRef, useImperativeHandle, useState } from "react";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  IssueChatThread,
  VIRTUALIZED_THREAD_ROW_THRESHOLD,
  canStopIssueChatRun,
  findLatestCommentMessageIndex,
  getVirtualizedMeasurementScrollAdjustment,
  resolveAssistantMessageFoldedState,
  resolveIssueChatHumanAuthor,
} from "./IssueChatThread";
import type {
  AskUserQuestionsInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";
import {
  issueChatLongThreadAgentMap,
  issueChatLongThreadComments,
  issueChatLongThreadEvents,
  issueChatLongThreadLinkedRuns,
  issueChatLongThreadTranscriptsByRunId,
} from "../fixtures/issueChatLongThreadFixture";
import type {
  IssueChatLinkedRun,
  IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";

function flushAct<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  return result as T;
}

function hasSmoothScrollBehavior(arg: unknown) {
  return typeof arg === "object"
    && arg !== null
    && "behavior" in arg
    && (arg as ScrollToOptions).behavior === "smooth";
}

const { markdownBodyRenderMock, markdownEditorFocusMock } = vi.hoisted(() => ({
  markdownBodyRenderMock: vi.fn(),
  markdownEditorFocusMock: vi.fn(),
}));

const { appendMock } = vi.hoisted(() => ({
  appendMock: vi.fn(async () => undefined),
}));

const {
  captureComposerViewportSnapshotMock,
  restoreComposerViewportSnapshotMock,
  shouldPreserveComposerViewportMock,
} = vi.hoisted(() => ({
  captureComposerViewportSnapshotMock: vi.fn(),
  restoreComposerViewportSnapshotMock: vi.fn(),
  shouldPreserveComposerViewportMock: vi.fn(),
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useAui: () => ({ thread: () => ({ append: appendMock }) }),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("../lib/issue-chat-scroll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/issue-chat-scroll")>();
  return {
    ...actual,
    captureComposerViewportSnapshot: captureComposerViewportSnapshotMock.mockImplementation(actual.captureComposerViewportSnapshot),
    restoreComposerViewportSnapshot: restoreComposerViewportSnapshotMock.mockImplementation(actual.restoreComposerViewportSnapshot),
    shouldPreserveComposerViewport: shouldPreserveComposerViewportMock.mockImplementation(actual.shouldPreserveComposerViewport),
  };
});

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: ReactNode; className?: string }) => {
    markdownBodyRenderMock({ children, className });
    return <div className={className}>{children}</div>;
  },
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(({
    value = "",
    onChange,
    placeholder,
    className,
    contentClassName,
    fileDropTarget,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    className?: string;
    contentClassName?: string;
    fileDropTarget?: "editor" | "parent";
  }, ref) => {
    useImperativeHandle(ref, () => ({
      focus: markdownEditorFocusMock,
    }));

    return (
      <textarea
        aria-label="Issue chat editor"
        data-class-name={className}
        data-content-class-name={contentClassName}
        data-file-drop-target={fileDropTarget}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }),
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./OutputFeedbackButtons", () => ({
  OutputFeedbackButtons: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({
    children,
    to,
    issuePathId,
    className,
  }: {
    children: ReactNode;
    to: string;
    issuePathId: string;
    className?: string;
  }) => (
    <a href={to} data-issue-path-id={issuePathId} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createSuggestedTasksInteraction(
  overrides: Partial<SuggestTasksInteraction> = {},
): SuggestTasksInteraction {
  return {
    id: "interaction-suggest-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "suggest_tasks",
    title: "Suggested follow-up work",
    summary: "Preview the next issue tree before accepting it.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:02:00.000Z"),
    updatedAt: new Date("2026-04-06T12:02:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      tasks: [
        {
          clientKey: "task-1",
          title: "Prototype the card",
        },
      ],
    },
    result: null,
    ...overrides,
  };
}

function createQuestionInteraction(
  overrides: Partial<AskUserQuestionsInteraction> = {},
): AskUserQuestionsInteraction {
  return {
    id: "interaction-question-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "ask_user_questions",
    title: "Clarify the phase",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:03:00.000Z"),
    updatedAt: new Date("2026-04-06T12:03:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      submitLabel: "Submit answers",
      questions: [
        {
          id: "scope",
          prompt: "Pick one scope",
          selectionMode: "single",
          required: true,
          options: [
            { id: "phase-1", label: "Phase 1" },
            { id: "phase-2", label: "Phase 2" },
          ],
        },
      ],
    },
    result: null,
    ...overrides,
  };
}

function createExpiredRequestConfirmationInteraction(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "interaction-confirmation-expired",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    status: "expired",
    continuationPolicy: "wake_assignee_on_accept",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: "user-1",
    createdAt: new Date("2026-04-06T12:04:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    resolvedAt: new Date("2026-04-06T12:05:00.000Z"),
    payload: {
      version: 1,
      prompt: "Approve the plan and let the responsible start implementation?",
      acceptLabel: "Approve plan",
      rejectLabel: "Request revisions",
    },
    result: {
      version: 1,
      outcome: "superseded_by_comment",
      commentId: "comment-1",
    },
    ...overrides,
  };
}

function createFileDragEvent(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: {
      types: string[];
      files: File[];
      dropEffect?: string;
    };
  };
  event.dataTransfer = {
    types: ["Files"],
    files,
  };
  return event;
}

describe("IssueChatThread", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.scrollTo = vi.fn();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    appendMock.mockReset();
    markdownEditorFocusMock.mockReset();
    captureComposerViewportSnapshotMock.mockClear();
    restoreComposerViewportSnapshotMock.mockClear();
    shouldPreserveComposerViewportMock.mockClear();
    markdownBodyRenderMock.mockClear();
  });

  it("drops the count heading and does not use an internal scrollbox", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Jump to latest");
    expect(container.textContent).not.toContain("Chat (");

    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLDivElement | null;
    expect(viewport).not.toBeNull();
    expect(viewport?.className).not.toContain("overflow-y-auto");
    expect(viewport?.className).not.toContain("max-h-(--sz-70vh)");

    act(() => {
      root.unmount();
    });
  });

  it("uses accent-safe markdown color in the current user's blue message bubble", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-current-user",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-board",
              authorType: "user",
              body: "1. **Readable** markdown on blue",
              presentation: null,
              metadata: null,
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:00:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            currentUserId="user-board"
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(markdownBodyRenderMock).toHaveBeenCalledWith(expect.objectContaining({
      children: "1. **Readable** markdown on blue",
      className: expect.stringContaining("paperclip-markdown-on-accent"),
    }));

    act(() => {
      root.unmount();
    });
  });

  it("labels operator-interrupted cancelled runs as interrupted while preserving plain cancelled runs", () => {
    const root = createRoot(container);
    const linkedRuns: IssueChatLinkedRun[] = [
      {
        runId: "run-interrupted",
        status: "cancelled",
        agentId: "agent-1",
        agentName: "CodexCoder",
        createdAt: new Date("2026-04-06T12:00:00.000Z"),
        startedAt: new Date("2026-04-06T12:00:00.000Z"),
        finishedAt: new Date("2026-04-06T12:01:00.000Z"),
        errorCode: "operator_interrupted",
        resultJson: { operatorInterrupted: true, interruptionSource: "issue_comment_interrupt" },
      },
      {
        runId: "run-cancelled",
        status: "cancelled",
        agentId: "agent-1",
        agentName: "CodexCoder",
        createdAt: new Date("2026-04-06T12:02:00.000Z"),
        startedAt: new Date("2026-04-06T12:02:00.000Z"),
        finishedAt: new Date("2026-04-06T12:03:00.000Z"),
        resultJson: { stopReason: "cancelled" },
      },
    ];

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={linkedRuns}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("interrupted by board after 1 minute");
    expect(container.textContent).toContain("cancelled after 1 minute");
    expect(container.textContent).not.toContain("run interrupted");

    act(() => {
      root.unmount();
    });
  });

  it("falls back to execCommand for comment copy actions in insecure contexts", async () => {
    const clipboardWrite = vi.fn(async () => {
      throw new Error("Clipboard API blocked");
    });
    const execCommand = vi.fn(() => true);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    try {
      const root = createRoot(container);

      act(() => {
        root.render(
          <MemoryRouter>
            <IssueChatThread
              comments={[{
                id: "comment-copy",
                companyId: "company-1",
                issueId: "issue-1",
                authorAgentId: null,
                authorUserId: "user-1",
                authorType: "user",
                body: "Copy this comment",
                presentation: null,
                metadata: null,
                createdAt: new Date("2026-04-06T12:00:00.000Z"),
                updatedAt: new Date("2026-04-06T12:00:00.000Z"),
              }]}
              linkedRuns={[]}
              timelineEvents={[]}
              liveRuns={[]}
              onAdd={async () => {}}
              showComposer={false}
              enableLiveTranscriptPolling={false}
            />
          </MemoryRouter>,
        );
      });

      const copyButton = container.querySelector('button[aria-label="Copy message"]') as HTMLButtonElement | null;
      expect(copyButton).not.toBeNull();

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(clipboardWrite).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith("copy");

      act(() => {
        root.unmount();
      });
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete navigator.clipboard;
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete document.execCommand;
      }
      if (originalSecureContext) {
        Object.defineProperty(window, "isSecureContext", originalSecureContext);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete window.isSecureContext;
      }
    }
  });

  it("renders footer content inside the thread viewport before the bottom anchor", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
            footer={<div>Sibling footer</div>}
          />
        </MemoryRouter>,
      );
    });

    const viewport = container.querySelector('[data-testid="thread-viewport"]');
    const footer = container.querySelector('[data-testid="issue-chat-thread-footer"]');
    expect(viewport).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toBe("Sibling footer");
    expect(footer?.parentElement).toBe(viewport);
    expect(footer?.nextElementSibling?.textContent).toBe("");

    act(() => {
      root.unmount();
    });
  });

  it("renders the composer in planning mode when the issue is in planning mode", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueWorkMode="planning"
            onWorkModeChange={() => {}}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]');
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(composer?.className).toContain("amber");

    const toggle = container.querySelector(
      '[data-testid="issue-chat-composer-work-mode-toggle"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.textContent).toContain("Plan mode");

    act(() => {
      root.unmount();
    });
  });

  it("shows a persistent neutral mode chip on a standard issue and selects planning through its menu", () => {
    const root = createRoot(container);
    const onWorkModeChange = vi.fn();

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueWorkMode="standard"
            onWorkModeChange={onWorkModeChange}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    // The mode chip is always present (mockup rev 5) — neutral "Agent mode" here.
    const chip = container.querySelector(
      '[data-testid="issue-chat-composer-work-mode-toggle"]',
    ) as HTMLButtonElement | null;
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-pending-work-mode")).toBe("standard");
    expect(chip?.textContent).toContain("Agent mode");

    const composer = container.querySelector('[data-testid="issue-chat-composer"]');
    expect(composer?.getAttribute("data-pending-work-mode")).toBe("standard");
    expect(composer?.className).not.toContain("amber");

    act(() => {
      chip?.click();
    });

    const menuItem = document.querySelector(
      '[data-testid="issue-chat-composer-work-mode-menu-planning"]',
    ) as HTMLButtonElement | null;
    expect(menuItem).not.toBeNull();
    expect(menuItem?.textContent).toContain("Plan mode");

    act(() => {
      menuItem?.click();
    });

    // Local pending switch only — does not mutate the issue until submit.
    expect(onWorkModeChange).not.toHaveBeenCalled();
    expect(composer?.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(composer?.className).toContain("amber");
    expect(chip?.textContent).toContain("Plan mode");

    act(() => {
      root.unmount();
    });
  });

  it("selects ask mode from the composer menu and cycles work modes with cmd-period", () => {
    const root = createRoot(container);
    const onWorkModeChange = vi.fn();

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueWorkMode="standard"
            onWorkModeChange={onWorkModeChange}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const chip = container.querySelector(
      '[data-testid="issue-chat-composer-work-mode-toggle"]',
    ) as HTMLButtonElement | null;
    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(chip).not.toBeNull();
    expect(composer).not.toBeNull();

    act(() => {
      chip?.click();
    });

    const askMenuItem = document.querySelector(
      '[data-testid="issue-chat-composer-work-mode-menu-ask"]',
    ) as HTMLButtonElement | null;
    expect(askMenuItem).not.toBeNull();
    expect(askMenuItem?.textContent).toContain("Ask mode");

    act(() => {
      askMenuItem?.click();
    });

    expect(onWorkModeChange).not.toHaveBeenCalled();
    expect(composer?.getAttribute("data-pending-work-mode")).toBe("ask");
    expect(composer?.className).toContain("sky");
    expect(chip?.textContent).toContain("Ask mode");

    act(() => {
      composer?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });

    expect(composer?.getAttribute("data-pending-work-mode")).toBe("standard");
    expect(chip?.textContent).toContain("Agent mode");

    act(() => {
      root.unmount();
    });
  });

  it("cycles work modes and prevents default when iOS leaves the keydown code empty", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueWorkMode="standard"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute("data-pending-work-mode")).toBe("standard");

    // iOS Safari with a hardware keyboard frequently reports an empty `code` for
    // cmd-period. Without a `key` fallback the handler returns early, never calls
    // preventDefault, and Safari's default cancel/dismiss closes the view.
    const evt = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "",
      key: ".",
      metaKey: true,
    });
    act(() => {
      composer?.dispatchEvent(evt);
    });

    expect(evt.defaultPrevented).toBe(true);
    expect(composer?.getAttribute("data-pending-work-mode")).not.toBe("standard");

    act(() => {
      root.unmount();
    });
  });

  it("virtualizes long merged threads so only a windowed slice mounts", () => {
    const root = createRoot(container);
    const totalMergedRows =
      issueChatLongThreadComments.length
      + issueChatLongThreadEvents.length
      + issueChatLongThreadLinkedRuns.length;
    expect(totalMergedRows).toBeGreaterThanOrEqual(VIRTUALIZED_THREAD_ROW_THRESHOLD);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            autoScrollToHashOnInitialLoad
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    const virtualizer = container.querySelector(
      '[data-testid="issue-chat-thread-virtualizer"]',
    ) as HTMLDivElement | null;
    expect(virtualizer).not.toBeNull();
    expect(virtualizer?.dataset.virtualCount).toBe(String(totalMergedRows));

    const rows = container.querySelectorAll('[data-testid="issue-chat-message-row"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(totalMergedRows);

    const virtualRows = container.querySelectorAll(
      '[data-testid="issue-chat-thread-virtual-row"]',
    );
    expect(virtualRows.length).toBe(rows.length);
    for (const row of Array.from(virtualRows)) {
      const transform = (row as HTMLDivElement).style.transform;
      expect(transform).toMatch(/translateY\(/);
    }

    act(() => {
      root.unmount();
    });
  });

  it("measures tall virtual rows before positioning following rows", async () => {
    const root = createRoot(container);
    const requestAnimationFrameMock = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 0;
      });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    const virtualRows = container.querySelectorAll<HTMLDivElement>(
      '[data-testid="issue-chat-thread-virtual-row"]',
    );
    expect(virtualRows.length).toBeGreaterThan(1);

    Object.defineProperty(virtualRows[0], "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 700,
        height: 800,
        top: 0,
        right: 700,
        bottom: 800,
        left: 0,
        toJSON: () => ({}),
      }),
    });

    await act(async () => {
      virtualRows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const nextTransform = virtualRows[1].style.transform;
    const translateY = Number(nextTransform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? "0");
    expect(translateY).toBeGreaterThanOrEqual(800);

    act(() => {
      root.unmount();
    });
    requestAnimationFrameMock.mockRestore();
  });

  it("scrolls loaded hash targets through the virtualized message index when initial hash scrolling is enabled", () => {
    const root = createRoot(container);
    const targetComment = issueChatLongThreadComments.at(-1);
    expect(targetComment).toBeDefined();
    const scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/issues/PAP-1#comment-${targetComment!.id}`]}>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            autoScrollToHashOnInitialLoad
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    expect(scrollToMock.mock.calls.some(([arg]) => hasSmoothScrollBehavior(arg))).toBe(true);

    scrollToMock.mockRestore();
    act(() => {
      root.unmount();
    });
  });

  it("uses the virtualizer when jumping to the latest long-thread row", () => {
    const root = createRoot(container);
    const scrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    act(() => {
      jump?.click();
    });

    expect(scrollToMock.mock.calls.some(([arg]) => hasSmoothScrollBehavior(arg))).toBe(true);

    scrollToMock.mockRestore();
    act(() => {
      root.unmount();
    });
  });

  // Regression for PAP-2660: on the real issue page the chat thread is wrapped
  // in `<main id="main-content" overflow-auto>`, so the virtualizer must bind
  // to that ancestor's scroll instead of `window` (which never moves on
  // desktop). When mounted inside an overflow-auto ancestor the jump-to-latest
  // action must drive that element's scrollTo, not window.scrollTo.
  it("targets an overflow-auto ancestor instead of window scroll on jump-to-latest", () => {
    container.remove();
    const scrollHost = document.createElement("main");
    scrollHost.id = "main-content";
    scrollHost.style.overflowY = "auto";
    scrollHost.style.overflow = "auto";
    scrollHost.style.height = "640px";
    document.body.appendChild(scrollHost);
    container = document.createElement("div");
    scrollHost.appendChild(container);

    const root = createRoot(container);
    const windowScrollToMock = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const elementScrollToMock = vi.fn();
    scrollHost.scrollTo = elementScrollToMock as unknown as typeof scrollHost.scrollTo;

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    windowScrollToMock.mockClear();
    elementScrollToMock.mockClear();

    act(() => {
      jump?.click();
    });

    expect(elementScrollToMock.mock.calls.some(([arg]) => hasSmoothScrollBehavior(arg))).toBe(true);
    expect(windowScrollToMock.mock.calls.some(([arg]) => hasSmoothScrollBehavior(arg))).toBe(false);

    windowScrollToMock.mockRestore();
    act(() => {
      root.unmount();
    });
    scrollHost.remove();
  });

  it("cancels jump-to-latest settling when the user scrolls manually", () => {
    vi.useFakeTimers();
    container.remove();
    const scrollHost = document.createElement("main");
    scrollHost.id = "main-content";
    scrollHost.style.overflowY = "auto";
    scrollHost.style.overflow = "auto";
    scrollHost.style.height = "640px";
    document.body.appendChild(scrollHost);
    container = document.createElement("div");
    scrollHost.appendChild(container);

    const elementScrollToMock = vi.fn();
    scrollHost.scrollTo = elementScrollToMock as unknown as typeof scrollHost.scrollTo;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock as unknown as typeof Element.prototype.scrollIntoView;

    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    // Flush pending mount timers so this test measures only the explicit
    // jump-to-latest interaction.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    elementScrollToMock.mockClear();
    scrollIntoViewMock.mockClear();

    act(() => {
      jump?.click();
    });

    expect(elementScrollToMock.mock.calls.some(([arg]) => hasSmoothScrollBehavior(arg))).toBe(true);
    const scrollCallsAfterClick = elementScrollToMock.mock.calls.length;

    act(() => {
      scrollHost.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      vi.advanceTimersByTime(500);
    });

    expect(elementScrollToMock).toHaveBeenCalledTimes(scrollCallsAfterClick);
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    Element.prototype.scrollIntoView = originalScrollIntoView;
    act(() => {
      root.unmount();
    });
    scrollHost.remove();
  });

  // PAP-12003: initial page load must not jump to the latest comment. If a
  // user wants the newest message, the explicit Jump to latest control owns it.
  it("does not auto-scroll to the latest comment on initial load", () => {
    vi.useFakeTimers();
    container.remove();
    const scrollHost = document.createElement("main");
    scrollHost.id = "main-content";
    scrollHost.style.overflowY = "auto";
    scrollHost.style.overflow = "auto";
    scrollHost.style.height = "640px";
    document.body.appendChild(scrollHost);
    container = document.createElement("div");
    scrollHost.appendChild(container);

    const elementScrollToMock = vi.fn();
    scrollHost.scrollTo = elementScrollToMock as unknown as typeof scrollHost.scrollTo;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock as unknown as typeof Element.prototype.scrollIntoView;

    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    // No jump click: initial render should preserve the page position.
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(elementScrollToMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    Element.prototype.scrollIntoView = originalScrollIntoView;
    act(() => {
      root.unmount();
    });
    scrollHost.remove();
    vi.useRealTimers();
  });

  it("can keep the page at the top on initial load while preserving manual jump-to-latest", () => {
    vi.useFakeTimers();
    container.remove();
    const scrollHost = document.createElement("main");
    scrollHost.id = "main-content";
    scrollHost.style.overflowY = "auto";
    scrollHost.style.overflow = "auto";
    scrollHost.style.height = "640px";
    document.body.appendChild(scrollHost);
    container = document.createElement("div");
    scrollHost.appendChild(container);

    const elementScrollToMock = vi.fn();
    scrollHost.scrollTo = elementScrollToMock as unknown as typeof scrollHost.scrollTo;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock as unknown as typeof Element.prototype.scrollIntoView;

    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(elementScrollToMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    act(() => {
      jump?.click();
    });

    const scrolledToLatest =
      elementScrollToMock.mock.calls.some(([arg]) => hasSmoothScrollBehavior(arg))
      || scrollIntoViewMock.mock.calls.length > 0;
    expect(scrolledToLatest).toBe(true);

    Element.prototype.scrollIntoView = originalScrollIntoView;
    act(() => {
      root.unmount();
    });
    scrollHost.remove();
    vi.useRealTimers();
  });

  it("can keep the page at the top on initial load even when the URL has a comment hash", () => {
    vi.useFakeTimers();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });

    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/PAP/issues/PAP-12003#comment-comment-target"]}>
          <IssueChatThread
            comments={[{
              id: "comment-target",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: "agent-1",
              authorUserId: null,
              authorType: "agent",
              body: "Previous done comment near the bottom.",
              presentation: null,
              metadata: null,
              createdAt: new Date("2026-07-07T21:13:07.902Z"),
              updatedAt: new Date("2026-07-07T21:13:07.902Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
    act(() => {
      root.unmount();
    });
    vi.useRealTimers();
  });

  // Regression for PAP-2672: when the merged feed ends with a non-comment row
  // (run/timeline/embedded output) we still want Jump to latest to land on the
  // last comment, not whichever activity row sorts last.
  it("targets the latest comment row when trailing rows are non-comments (PAP-2672)", () => {
    const lastComment = issueChatLongThreadComments.at(-1);
    expect(lastComment).toBeDefined();
    const trailingRunStart = new Date(new Date(lastComment!.createdAt).getTime() + 60_000);
    const trailingRun: IssueChatLinkedRun = {
      runId: "trailing-run-pap-2672",
      status: "failed",
      agentId: "agent-perf-codex",
      agentName: "TrailingRunner",
      adapterType: "codex_local",
      createdAt: trailingRunStart,
      startedAt: trailingRunStart,
      finishedAt: trailingRunStart,
      hasStoredOutput: true,
    };
    const trailingTranscriptEntries: readonly IssueChatTranscriptEntry[] = [
      {
        kind: "assistant",
        ts: trailingRunStart.toISOString(),
        text: "Trailing run posted after the latest comment.",
      },
    ];
    const transcriptsByRunId = new Map(issueChatLongThreadTranscriptsByRunId);
    transcriptsByRunId.set(trailingRun.runId, trailingTranscriptEntries);
    const linkedRuns: IssueChatLinkedRun[] = [
      ...issueChatLongThreadLinkedRuns,
      trailingRun,
    ];

    container.remove();
    const scrollHost = document.createElement("main");
    scrollHost.id = "main-content";
    scrollHost.style.overflowY = "auto";
    scrollHost.style.overflow = "auto";
    scrollHost.style.height = "800px";
    Object.defineProperty(scrollHost, "scrollHeight", {
      configurable: true,
      get: () => 200_000,
    });
    Object.defineProperty(scrollHost, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
    document.body.appendChild(scrollHost);
    container = document.createElement("div");
    scrollHost.appendChild(container);

    const elementScrollToMock = vi.fn();
    scrollHost.scrollTo = elementScrollToMock as unknown as typeof scrollHost.scrollTo;

    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={linkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={transcriptsByRunId}
            hasOutputForRun={(runId) => transcriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    const virtualizerEl = container.querySelector<HTMLDivElement>(
      '[data-testid="issue-chat-thread-virtualizer"]',
    );
    expect(virtualizerEl).not.toBeNull();
    const totalMergedRows = Number(virtualizerEl?.dataset.virtualCount ?? "0");
    expect(totalMergedRows).toBeGreaterThan(VIRTUALIZED_THREAD_ROW_THRESHOLD);

    elementScrollToMock.mockClear();

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    act(() => {
      jump?.click();
    });

    const smoothCalls = elementScrollToMock.mock.calls
      .map((call) => call[0] as ScrollToOptions)
      .filter(hasSmoothScrollBehavior);
    expect(smoothCalls.length).toBeGreaterThan(0);

    // For align="end" with the very last index, tanstack-virtual short-circuits
    // to getMaxScrollOffset() (= scrollHeight - clientHeight = 199_200 here).
    // A jump to the latest comment row (one slot earlier) lands at item.end -
    // clientHeight, which is strictly less. Asserting top < maxScrollOffset
    // proves the button isn't routing to the trailing run row.
    const maxScrollOffset = 200_000 - 800;
    const lastTop = smoothCalls[smoothCalls.length - 1]?.top;
    expect(typeof lastTop).toBe("number");
    expect(lastTop as number).toBeLessThan(maxScrollOffset);
    expect(lastTop as number).toBeGreaterThan(0);

    act(() => {
      root.unmount();
    });
    scrollHost.remove();
  });

  // Regression for PAP-2672 follow-up: clicking Jump to latest must refresh
  // the comments page so a comment that arrived after the initial load is
  // present before we scroll. Otherwise the user lands on the latest *loaded*
  // comment but not the absolute newest.
  it("invokes onRefreshLatestComments before scrolling on Jump to latest", async () => {
    const refreshMock = vi.fn(async () => undefined);
    const directComments = issueChatLongThreadComments.slice(0, 8);

    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={directComments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
            onRefreshLatestComments={refreshMock}
          />
        </MemoryRouter>,
      );
    });

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    act(() => {
      jump?.click();
    });

    expect(refreshMock).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("uses comments rendered by onRefreshLatestComments before resolving latest", async () => {
    const scrolledIds: string[] = [];
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn(function scrollIntoView(this: Element) {
      scrolledIds.push(this.id);
    }) as unknown as typeof Element.prototype.scrollIntoView;

    const olderComment = {
      id: "comment-before-refresh",
      companyId: "company-1",
      issueId: "issue-1",
      authorAgentId: "agent-perf-codex",
      authorUserId: null,
      body: "Older loaded comment",
      authorType: "agent" as const,
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-04-06T12:00:00.000Z"),
      updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    };
    const latestComment = {
      ...olderComment,
      id: "comment-after-refresh",
      body: "Latest fetched comment",
      createdAt: new Date("2026-04-06T12:01:00.000Z"),
      updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    };

    function RefreshingThread() {
      const [comments, setComments] = useState([olderComment]);
      return (
        <IssueChatThread
          comments={comments}
          linkedRuns={[]}
          timelineEvents={[]}
          liveRuns={[]}
          agentMap={issueChatLongThreadAgentMap}
          currentUserId="user-board"
          onAdd={async () => {}}
          enableLiveTranscriptPolling={false}
          onRefreshLatestComments={async () => {
            setComments([olderComment, latestComment]);
            await new Promise((resolve) => window.requestAnimationFrame(resolve));
          }}
        />
      );
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RefreshingThread />
        </MemoryRouter>,
      );
    });

    const jump = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Jump to latest",
    ) as HTMLButtonElement | undefined;
    expect(jump).toBeDefined();

    await act(async () => {
      jump?.click();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(scrolledIds).toContain("comment-comment-after-refresh");

    Element.prototype.scrollIntoView = originalScrollIntoView;
    act(() => {
      root.unmount();
    });
  });

  it("findLatestCommentMessageIndex prefers the last comment-anchored row (PAP-2672)", () => {
    const messages = [
      { metadata: { custom: { anchorId: "comment-a" } } },
      { metadata: { custom: { anchorId: "run-1" } } },
      { metadata: { custom: { anchorId: "comment-b" } } },
      { metadata: { custom: { anchorId: "run-2" } } },
      { metadata: { custom: { anchorId: "activity-3" } } },
    ];
    expect(findLatestCommentMessageIndex(messages as never)).toBe(2);
    expect(
      findLatestCommentMessageIndex([
        { metadata: { custom: { anchorId: "run-only" } } },
      ] as never),
    ).toBe(-1);
    expect(findLatestCommentMessageIndex([] as never)).toBe(-1);
  });

  it("keeps the direct render path for short threads under the virtualization threshold", () => {
    const root = createRoot(container);
    const directComments = issueChatLongThreadComments.slice(0, 12);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={directComments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(
      container.querySelector('[data-testid="issue-chat-thread-virtualizer"]'),
    ).toBeNull();
    const rows = container.querySelectorAll('[data-testid="issue-chat-message-row"]');
    expect(rows.length).toBe(directComments.length);

    act(() => {
      root.unmount();
    });
  });

  it("keeps the viewport anchored when virtualized rows above it remeasure", () => {
    expect(getVirtualizedMeasurementScrollAdjustment({
      itemStart: 200,
      previousSize: 220,
      nextSize: 360,
      viewportStart: 480,
    })).toBe(140);

    expect(getVirtualizedMeasurementScrollAdjustment({
      itemStart: 200,
      previousSize: 360,
      nextSize: 180,
      viewportStart: 620,
    })).toBe(-180);
  });

  it("does not scroll-anchor virtualized measurement changes inside the viewport", () => {
    expect(getVirtualizedMeasurementScrollAdjustment({
      itemStart: 420,
      previousSize: 220,
      nextSize: 360,
      viewportStart: 480,
    })).toBe(0);
  });

  it("renders virtualized rows with the same role/kind metadata as the direct path", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={(runId) => issueChatLongThreadTranscriptsByRunId.has(runId)}
          />
        </MemoryRouter>,
      );
    });

    const rows = container.querySelectorAll('[data-testid="issue-chat-message-row"]');
    expect(rows.length).toBeGreaterThan(0);
    const roles = new Set<string>();
    const kinds = new Set<string>();
    for (const row of Array.from(rows)) {
      const element = row as HTMLDivElement;
      const role = element.dataset.messageRole;
      const kind = element.dataset.messageKind;
      if (role) roles.add(role);
      if (kind) kinds.add(kind);
    }
    expect(roles.size).toBeGreaterThan(0);
    expect(kinds.size).toBeGreaterThan(0);

    act(() => {
      root.unmount();
    });
  });

  it("does not re-render long-thread markdown rows for unrelated layout updates", () => {
    const root = createRoot(container);
    const onAdd = async () => {};
    const hasOutputForRun = (runId: string) => issueChatLongThreadTranscriptsByRunId.has(runId);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={onAdd}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={hasOutputForRun}
          />
        </MemoryRouter>,
      );
    });

    expect(markdownBodyRenderMock).toHaveBeenCalled();
    markdownBodyRenderMock.mockClear();

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={issueChatLongThreadComments}
            linkedRuns={issueChatLongThreadLinkedRuns}
            timelineEvents={issueChatLongThreadEvents}
            liveRuns={[]}
            agentMap={issueChatLongThreadAgentMap}
            currentUserId="user-board"
            onAdd={onAdd}
            showComposer={false}
            showJumpToLatest
            enableLiveTranscriptPolling={false}
            transcriptsByRunId={issueChatLongThreadTranscriptsByRunId}
            hasOutputForRun={hasOutputForRun}
          />
        </MemoryRouter>,
      );
    });

    expect(markdownBodyRenderMock).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("does not re-render unchanged markdown when feedback votes change", () => {
    const root = createRoot(container);
    const onAdd = async () => {};
    const onVote = async () => {};
    const comments = [{
      id: "comment-agent-feedback",
      companyId: "company-1",
      issueId: "issue-1",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Agent summary with **markdown**",
      authorType: "agent" as const,
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-04-06T12:00:00.000Z"),
      updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    }];

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={comments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={onAdd}
            onVote={onVote}
            feedbackVotes={[]}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(markdownBodyRenderMock).toHaveBeenCalled();
    markdownBodyRenderMock.mockClear();

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={comments}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={onAdd}
            onVote={onVote}
            feedbackVotes={[{
              id: "feedback-1",
              companyId: "company-1",
              issueId: "issue-1",
              targetType: "issue_comment",
              targetId: "comment-agent-feedback",
              authorUserId: "user-1",
              vote: "up",
              reason: null,
              sharedWithLabs: false,
              sharedAt: null,
              consentVersion: null,
              redactionSummary: null,
              createdAt: new Date("2026-04-06T12:01:00.000Z"),
              updatedAt: new Date("2026-04-06T12:01:00.000Z"),
            }]}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(markdownBodyRenderMock).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("renders a genuine agent comment in the conference-room neutral bubble (PAP-97 rev 7)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-agent-bubble",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: "agent-1",
              authorUserId: null,
              body: "Here is my agent reply.",
              authorType: "agent" as const,
              presentation: null,
              metadata: null,
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:00:00.000Z"),
            }]}
            currentUserId="user-board"
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    // Conference-room canonical agent bubble: bg-card + border + tail corner.
    const bubble = Array.from(container.querySelectorAll("div")).find(
      (el) =>
        el.className.includes("bg-card")
        && el.className.includes("border-border")
        && el.className.includes("[border-radius:14px_14px_14px_4px]"),
    );
    expect(bubble).toBeDefined();
    expect(bubble?.textContent).toContain("Here is my agent reply.");
    expect(bubble?.className).toContain("max-w-(--sz-calc-7)");
    expect(bubble?.className).toContain("sm:max-w-(--pct-85)");
    // Neutral, not the human liveness-blue bubble (--liveness-blue, DECISION-SHEET.md A6).
    expect(bubble?.className).not.toContain("bg-(--liveness-blue)");

    act(() => {
      root.unmount();
    });
  });

  it("confirms and invokes delete only for the current user's normal comments", async () => {
    const root = createRoot(container);
    const onDeleteComment = vi.fn(async () => {});

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[
              {
                id: "comment-owned",
                companyId: "company-1",
                issueId: "issue-1",
                authorAgentId: null,
                authorUserId: "user-board",
                body: "Delete me",
                authorType: "user",
                presentation: null,
                metadata: null,
                createdAt: new Date("2026-04-06T12:00:00.000Z"),
                updatedAt: new Date("2026-04-06T12:00:00.000Z"),
              },
              {
                id: "comment-other",
                companyId: "company-1",
                issueId: "issue-1",
                authorAgentId: null,
                authorUserId: "user-other",
                body: "Do not delete",
                authorType: "user",
                presentation: null,
                metadata: null,
                createdAt: new Date("2026-04-06T12:01:00.000Z"),
                updatedAt: new Date("2026-04-06T12:01:00.000Z"),
              },
            ]}
            currentUserId="user-board"
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onDeleteComment={onDeleteComment}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const deleteButtons = Array.from(container.querySelectorAll("button[aria-label='Delete comment']"));
    expect(deleteButtons).toHaveLength(1);

    await act(async () => {
      deleteButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Delete comment?");
    const confirmButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Delete comment");
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onDeleteComment).toHaveBeenCalledWith("comment-owned");

    act(() => {
      root.unmount();
    });
  });

  it("renders deleted comments as tombstones without the original body", () => {
    const root = createRoot(container);

    flushAct(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-deleted",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-board",
              body: "Sensitive deleted body",
              authorType: "user",
              presentation: null,
              metadata: null,
              deletedAt: new Date("2026-04-06T12:05:00.000Z"),
              deletedByType: "user",
              deletedByUserId: "user-board",
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:05:00.000Z"),
            }]}
            currentUserId="user-board"
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onDeleteComment={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("You deleted this comment");
    expect(container.textContent).not.toContain("Sensitive deleted body");
    expect(container.querySelector("button[aria-label='Delete comment']")).toBeNull();
    expect(container.querySelector("button[aria-label='Copy message']")).toBeNull();

    flushAct(() => {
      root.unmount();
    });
  });

  it("clears a deleted comment deep-link hash instead of highlighting it", () => {
    const root = createRoot(container);
    const replaceStateSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});

    flushAct(() => {
      root.render(
        <MemoryRouter initialEntries={["/issues/PAP-1#comment-comment-deleted"]}>
          <IssueChatThread
            comments={[{
              id: "comment-deleted",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-board",
              body: "Sensitive deleted body",
              authorType: "user",
              presentation: null,
              metadata: null,
              deletedAt: new Date("2026-04-06T12:05:00.000Z"),
              deletedByType: "user",
              deletedByUserId: "user-board",
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:05:00.000Z"),
            }]}
            currentUserId="user-board"
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/issues/PAP-1");

    replaceStateSpy.mockRestore();
    flushAct(() => {
      root.unmount();
    });
  });

  it("shows explicit follow-up badges and event copy", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "local-board",
              body: "Please continue validation.",
              authorType: "user",
              presentation: null,
              metadata: null,
              followUpRequested: true,
              createdAt: new Date("2026-03-11T10:00:00.000Z"),
              updatedAt: new Date("2026-03-11T10:00:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[{
              id: "event-1",
              actorType: "agent",
              actorId: "agent-1",
              createdAt: new Date("2026-03-11T10:00:00.000Z"),
              commentId: "comment-1",
              followUpRequested: true,
            }]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Follow-up");
    expect(container.textContent).toContain("requested follow-up");

    act(() => {
      root.unmount();
    });
  });

  it("shows unresolved blocker context above the composer", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueStatus="todo"
            blockedBy={[
              {
                id: "blocker-1",
                identifier: "PAP-1723",
                title: "QA the install flow",
                status: "blocked",
                priority: "medium",
                assigneeAgentId: "agent-1",
                assigneeUserId: null,
              },
            ]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("PAP-1723");
    expect(container.textContent).toContain("QA the install flow");
    expect(container.querySelector('[data-issue-path-id="PAP-1723"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("shows terminal blocker context when an immediate blocker is transitively blocked", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueStatus="blocked"
            blockedBy={[
              {
                id: "blocker-1",
                identifier: "PAP-2167",
                title: "Phase 7 review",
                status: "blocked",
                priority: "medium",
                assigneeAgentId: "agent-1",
                assigneeUserId: null,
                terminalBlockers: [
                  {
                    id: "terminal-1",
                    identifier: "PAP-2201",
                    title: "Security sign-off",
                    status: "todo",
                    priority: "high",
                    assigneeAgentId: "agent-2",
                    assigneeUserId: null,
                  },
                ],
              },
            ]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("PAP-2167");
    expect(container.textContent).toContain("Phase 7 review");
    expect(container.textContent).toContain("Ultimately waiting on");
    expect(container.textContent).toContain("PAP-2201");
    expect(container.textContent).toContain("Security sign-off");
    expect(container.querySelector('[data-issue-path-id="PAP-2201"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders the blue 'Waiting on live work' variant when the blocker chain is covered", () => {
    const root = createRoot(container);

    flushAct(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueStatus="blocked"
            liveIssueIds={new Set(["blocker-run"])}
            blockerAttention={{
              state: "covered",
              reason: "active_dependency",
              unresolvedBlockerCount: 3,
              coveredBlockerCount: 3,
              stalledBlockerCount: 0,
              attentionBlockerCount: 0,
              sampleBlockerIdentifier: "PAP-2002",
              sampleStalledBlockerIdentifier: null,
            }}
            blockedBy={[
              {
                id: "blocker-done",
                identifier: "PAP-2001",
                title: "Server work",
                status: "done",
                priority: "medium",
                assigneeAgentId: "agent-1",
                assigneeUserId: null,
              },
              {
                id: "blocker-run",
                identifier: "PAP-2002",
                title: "UI work",
                status: "in_progress",
                priority: "medium",
                assigneeAgentId: "agent-2",
                assigneeUserId: null,
              },
              {
                id: "blocker-queued",
                identifier: "PAP-2003",
                title: "QA gate",
                status: "todo",
                priority: "medium",
                assigneeAgentId: "agent-3",
                assigneeUserId: null,
              },
            ]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const notice = container.querySelector('[data-testid="issue-blocked-notice-live"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("data-blocker-attention-state")).toBe("covered");
    expect(container.textContent).toContain("Waiting on live work");
    expect(container.textContent).toContain("resumes automatically when the chain is done");
    // Progress counts: 1 done, 1 running out of 3.
    expect(container.textContent).toContain("1 of 3 done · 1 running");
    // Amber "Ultimately waiting on" / "blocked by the linked task" copy is gone.
    expect(container.textContent).not.toContain("Ultimately waiting on");
    expect(container.textContent).not.toContain("Work on this task is blocked by");
    // All three blockers render as chips.
    expect(container.querySelector('[data-issue-path-id="PAP-2001"]')).not.toBeNull();
    expect(container.querySelector('[data-issue-path-id="PAP-2002"]')).not.toBeNull();
    expect(container.querySelector('[data-issue-path-id="PAP-2003"]')).not.toBeNull();

    flushAct(() => {
      root.unmount();
    });
  });

  it("shows a 'Now running' row replacing 'Ultimately waiting on' when the terminal leaf is live", () => {
    const root = createRoot(container);

    flushAct(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueStatus="blocked"
            liveIssueIds={new Set(["terminal-live"])}
            blockerAttention={{
              state: "covered",
              reason: "active_dependency",
              unresolvedBlockerCount: 1,
              coveredBlockerCount: 1,
              stalledBlockerCount: 0,
              attentionBlockerCount: 0,
              sampleBlockerIdentifier: "PAP-3001",
              sampleStalledBlockerIdentifier: null,
            }}
            blockedBy={[
              {
                id: "blocker-mid",
                identifier: "PAP-3001",
                title: "Phase 7 review",
                status: "blocked",
                priority: "medium",
                assigneeAgentId: "agent-1",
                assigneeUserId: null,
                terminalBlockers: [
                  {
                    id: "terminal-live",
                    identifier: "PAP-3002",
                    title: "Security sign-off",
                    status: "in_progress",
                    priority: "high",
                    assigneeAgentId: "agent-2",
                    assigneeUserId: null,
                  },
                ],
              },
            ]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const nowRunning = container.querySelector('[data-testid="issue-blocked-notice-now-running"]');
    expect(nowRunning).not.toBeNull();
    expect(nowRunning?.textContent).toContain("Now running");
    expect(nowRunning?.textContent).toContain("PAP-3002");
    expect(container.textContent).not.toContain("Ultimately waiting on");

    flushAct(() => {
      root.unmount();
    });
  });

  it("keeps the parked-work row amber inside the blue variant", () => {
    const root = createRoot(container);

    flushAct(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueStatus="blocked"
            liveIssueIds={new Set(["blocker-run"])}
            blockerAttention={{
              state: "covered",
              reason: "active_dependency",
              unresolvedBlockerCount: 2,
              coveredBlockerCount: 2,
              stalledBlockerCount: 0,
              attentionBlockerCount: 0,
              sampleBlockerIdentifier: "PAP-4001",
              sampleStalledBlockerIdentifier: null,
            }}
            blockedBy={[
              {
                id: "blocker-run",
                identifier: "PAP-4001",
                title: "UI work",
                status: "in_progress",
                priority: "medium",
                assigneeAgentId: "agent-1",
                assigneeUserId: null,
              },
              {
                id: "blocker-parked",
                identifier: "PAP-4002",
                title: "Parked backlog task",
                status: "backlog",
                priority: "medium",
                assigneeAgentId: "agent-2",
                assigneeUserId: null,
              },
            ]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.querySelector('[data-testid="issue-blocked-notice-live"]')).not.toBeNull();
    const parkedRow = container.querySelector('[data-testid="issue-blocked-notice-parked-row"]');
    expect(parkedRow).not.toBeNull();
    expect(parkedRow?.textContent).toContain("Blocked by parked work");
    // Parked label keeps its amber tone even inside the blue box.
    expect(parkedRow?.querySelector(".text-amber-800")).not.toBeNull();

    flushAct(() => {
      root.unmount();
    });
  });

  it("keeps the amber notice byte-for-byte for stalled / needs_attention / none states", () => {
    for (const state of ["stalled", "needs_attention", "none"] as const) {
      const root = createRoot(container);

      flushAct(() => {
        root.render(
          <MemoryRouter>
            <IssueChatThread
              comments={[]}
              linkedRuns={[]}
              timelineEvents={[]}
              liveRuns={[]}
              issueStatus="blocked"
              liveIssueIds={new Set(["blocker-1"])}
              blockerAttention={{
                state,
                reason: state === "stalled" ? "stalled_review" : null,
                unresolvedBlockerCount: 1,
                coveredBlockerCount: 0,
                stalledBlockerCount: state === "stalled" ? 1 : 0,
                attentionBlockerCount: state === "needs_attention" ? 1 : 0,
                sampleBlockerIdentifier: "PAP-5001",
                sampleStalledBlockerIdentifier: state === "stalled" ? "PAP-5001" : null,
              }}
              blockedBy={[
                {
                  id: "blocker-1",
                  identifier: "PAP-5001",
                  title: "Review task",
                  status: "in_review",
                  priority: "medium",
                  assigneeAgentId: "agent-1",
                  assigneeUserId: null,
                },
              ]}
              onAdd={async () => {}}
              enableLiveTranscriptPolling={false}
            />
          </MemoryRouter>,
        );
      });

      // Blue variant never appears for non-covered states.
      expect(container.querySelector('[data-testid="issue-blocked-notice-live"]')).toBeNull();
      // The amber container (with the canonical attention data attribute) does.
      const amber = container.querySelector(`[data-blocker-attention-state="${state}"]`);
      expect(amber).not.toBeNull();
      expect(amber?.className).toContain("border-amber-300/70");
      if (state === "stalled") {
        expect(container.textContent).toContain("Stalled in review");
      }

      flushAct(() => {
        root.unmount();
      });
    }
  });

  it("shows paused responsible agent context above the composer", () => {
    const root = createRoot(container);
    const pausedAgent = {
      id: "agent-1",
      companyId: "company-1",
      name: "CodexCoder",
      status: "paused",
      pauseReason: "manual",
    } as Agent;

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            agentMap={new Map([["agent-1", pausedAgent]])}
            currentAssigneeValue="agent:agent-1"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("CodexCoder is paused");
    expect(container.textContent).toContain("New runs will not start until the agent is resumed");
    expect(container.textContent).toContain("It was paused manually");

    act(() => {
      root.unmount();
    });
  });

  it("supports the embedded read-only variant without the jump control", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            variant="embedded"
            emptyMessage="No run output captured."
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("No run output captured.");
    expect(container.textContent).not.toContain("Jump to latest");

    const viewport = container.querySelector('[data-testid="thread-viewport"]') as HTMLDivElement | null;
    expect(viewport?.className).toContain("space-y-3");

    act(() => {
      root.unmount();
    });
  });

  it("invokes the accept callback for pending suggested-task interactions", async () => {
    const root = createRoot(container);
    const onAcceptInteraction = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            interactions={[createSuggestedTasksInteraction()]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onAcceptInteraction={onAcceptInteraction}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const acceptButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Accept drafts"),
    );
    expect(acceptButton).toBeTruthy();

    await act(async () => {
      acceptButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAcceptInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "interaction-suggest-1",
        kind: "suggest_tasks",
      }),
      ["task-1"],
    );

    act(() => {
      root.unmount();
    });
  });

  it("submits only the selected draft subtree when tasks are manually pruned", async () => {
    const root = createRoot(container);
    const onAcceptInteraction = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            interactions={[createSuggestedTasksInteraction({
              payload: {
                version: 1,
                tasks: [
                  {
                    clientKey: "root",
                    title: "Root task",
                  },
                  {
                    clientKey: "child",
                    parentClientKey: "root",
                    title: "Child task",
                  },
                ],
              },
            })]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onAcceptInteraction={onAcceptInteraction}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const childCheckbox = container.querySelector('[aria-label="Include Child task"]');
    expect(childCheckbox).toBeTruthy();

    await act(async () => {
      childCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const acceptButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Accept selected drafts"),
    );
    expect(acceptButton).toBeTruthy();
    await act(async () => {
      acceptButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAcceptInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "interaction-suggest-1",
        kind: "suggest_tasks",
      }),
      ["root"],
    );

    act(() => {
      root.unmount();
    });
  });

  it("submits selected answers for pending question interactions", async () => {
    const root = createRoot(container);
    const onSubmitInteractionAnswers = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            interactions={[createQuestionInteraction()]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onSubmitInteractionAnswers={onSubmitInteractionAnswers}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const optionButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Phase 1"),
    );
    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Submit answers"),
    );
    expect(optionButton).toBeTruthy();
    expect(submitButton).toBeTruthy();

    await act(async () => {
      optionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmitInteractionAnswers).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "interaction-question-1",
        kind: "ask_user_questions",
      }),
      [{ questionId: "scope", optionIds: ["phase-1"] }],
    );

    act(() => {
      root.unmount();
    });
  });

  it("submits Other text for pending question interactions", async () => {
    const root = createRoot(container);
    const onSubmitInteractionAnswers = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            interactions={[createQuestionInteraction()]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onSubmitInteractionAnswers={onSubmitInteractionAnswers}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const otherButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Other"),
    );
    expect(otherButton).toBeTruthy();

    await act(async () => {
      otherButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "Phase 1 plus docs");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Submit answers"),
    );

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSubmitInteractionAnswers).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "interaction-question-1",
        kind: "ask_user_questions",
      }),
      [{ questionId: "scope", optionIds: [], otherText: "Phase 1 plus docs" }],
    );

    act(() => {
      root.unmount();
    });
  });

  it("invokes the cancel callback for pending question interactions", async () => {
    const root = createRoot(container);
    const onCancelInteraction = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            interactions={[createQuestionInteraction()]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onCancelInteraction={onCancelInteraction}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const cancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Cancel question"),
    );
    expect(cancelButton).toBeTruthy();

    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCancelInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "interaction-question-1",
        kind: "ask_user_questions",
      }),
    );

    act(() => {
      root.unmount();
    });
  });

  it("folds expired request confirmations into an activity row by default", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            interactions={[createExpiredRequestConfirmationInteraction()]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            currentUserId="user-1"
            userLabelMap={new Map([["user-1", "Dotta"]])}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Dotta");
    expect(container.textContent).toContain("updated this task");
    expect(container.textContent).toContain("Expired confirmation");
    expect(container.textContent).not.toContain("Approve the plan");

    const toggleButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Expired confirmation"),
    );
    expect(toggleButton).toBeTruthy();

    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Approve the plan");
    expect(container.textContent).toContain("Confirmation expired after comment");

    act(() => {
      root.unmount();
    });
  });

  it("renders the transcript directly from stable Paperclip messages", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: "agent-1",
              authorUserId: null,
              body: "Agent summary",
              authorType: "agent",
              presentation: null,
              metadata: null,
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:00:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Agent summary");
    expect(container.textContent).not.toContain("Chat renderer hit an internal state error.");

    act(() => {
      root.unmount();
    });
  });

  it("shows deferred wake badge only for hold-deferred queued comments", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-hold",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "Need a quick update",
              authorType: "user",
              presentation: null,
              metadata: null,
              queueState: "queued",
              queueReason: "hold",
              createdAt: new Date("2026-04-06T12:00:00.000Z"),
              updatedAt: new Date("2026-04-06T12:00:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Deferred wake");

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-active-run",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "Queue behind active run",
              authorType: "user",
              presentation: null,
              metadata: null,
              queueState: "queued",
              queueReason: "active_run",
              createdAt: new Date("2026-04-06T12:01:00.000Z"),
              updatedAt: new Date("2026-04-06T12:01:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Queued");
    expect(container.textContent).not.toContain("Deferred wake");

    act(() => {
      root.unmount();
    });
  });

  it("stores and restores the composer draft per issue key", () => {
    vi.useFakeTimers();
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            draftKey="issue-chat-draft:test-1"
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor).not.toBeNull();
    expect(editor?.placeholder).toBe("Reply");

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Draft survives refresh");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(localStorage.getItem("issue-chat-draft:test-1")).toBe("Draft survives refresh");

    act(() => {
      root.unmount();
    });

    const remount = createRoot(container);
    act(() => {
      remount.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            draftKey="issue-chat-draft:test-1"
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const restoredEditor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(restoredEditor?.value).toBe("Draft survives refresh");

    act(() => {
      remount.unmount();
    });
  });

  it("keeps the composer floating with a capped editor height", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const dock = container.querySelector('[data-testid="issue-chat-composer-dock"]') as HTMLDivElement | null;
    expect(dock).not.toBeNull();
    expect(dock?.className).toContain("sticky");
    expect(dock?.className).toContain("bottom-(--sz-calc-8)");
    expect(dock?.className).toContain("z-20");

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.className).toContain("rounded-md");
    expect(composer?.className).not.toContain("rounded-lg");
    expect(composer?.className).toContain("p-(--sz-15px)");

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor?.dataset.contentClassName).toContain("max-h-(--sz-28dvh)");
    expect(editor?.dataset.contentClassName).toContain("overflow-y-auto");
    expect(editor?.dataset.contentClassName).not.toContain("min-h-(--sz-72px)");
    expect(editor?.dataset.fileDropTarget).toBe("parent");

    act(() => {
      root.unmount();
    });
  });

  it("shows full-composer drop instructions while dragging files over the issue composer", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            imageUploadHandler={async () => "/api/attachments/image/content"}
            onAttachImage={async () => undefined}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composer).not.toBeNull();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput?.getAttribute("accept")).toBeNull();

    act(() => {
      composer?.dispatchEvent(createFileDragEvent("dragenter", [
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ]));
    });

    expect(container.querySelector('[data-testid="issue-chat-composer-drop-overlay"]')).not.toBeNull();
    expect(container.textContent).toContain("Drop to upload");
    expect(container.textContent).toContain("Images insert into the reply");
    expect(container.textContent).toContain("Other files are added to this task");
    expect(composer?.className).toContain("border-primary/45");

    act(() => {
      root.unmount();
    });
  });

  it("shows non-image attachment upload state in the composer after a drop", async () => {
    const root = createRoot(container);
    const onAttachImage = vi.fn(async (file: File) => ({
      id: "attachment-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      assetId: "asset-1",
      provider: "local_disk",
      objectKey: "issues/issue-1/report.pdf",
      contentPath: "/api/attachments/attachment-1/content",
      originalFilename: file.name,
      contentType: file.type,
      byteSize: file.size,
      sha256: "abc123",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onAttachImage={onAttachImage}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    const file = new File(["report body"], "report.pdf", { type: "application/pdf" });

    await act(async () => {
      composer?.dispatchEvent(createFileDragEvent("drop", [file]));
    });

    expect(onAttachImage).toHaveBeenCalledWith(file);
    const attachmentList = container.querySelector('[data-testid="issue-chat-composer-attachments"]');
    expect(attachmentList).not.toBeNull();
    expect(container.textContent).toContain("report.pdf");
    expect(container.textContent).toContain("Attached to task");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows only the outer composer drop overlay when dragging over the reply editor", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            imageUploadHandler={async () => "/api/attachments/image/content"}
            onAttachImage={async () => undefined}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(composer).not.toBeNull();
    expect(editor).not.toBeNull();

    act(() => {
      editor?.dispatchEvent(createFileDragEvent("dragenter", [
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ]));
    });

    expect(container.querySelector('[data-testid="issue-chat-composer-drop-overlay"]')).not.toBeNull();
    expect(container.textContent).toContain("Drop to upload");
    expect(container.textContent).not.toContain("Drop image to upload");
    expect(composer?.className).toContain("border-primary/45");

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput?.getAttribute("accept")).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("shows non-image attachment upload state in the composer after a drop from the editor", async () => {
    const root = createRoot(container);
    const onAttachImage = vi.fn(async (file: File) => ({
      id: "attachment-1",
      companyId: "company-1",
      issueId: "issue-1",
      issueCommentId: null,
      assetId: "asset-1",
      provider: "local_disk",
      objectKey: "issues/issue-1/report.pdf",
      contentPath: "/api/attachments/attachment-1/content",
      originalFilename: file.name,
      contentType: file.type,
      byteSize: file.size,
      sha256: "abc123",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
    }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            onAttachImage={onAttachImage}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    const file = new File(["report body"], "report.pdf", { type: "application/pdf" });

    await act(async () => {
      editor?.dispatchEvent(createFileDragEvent("drop", [file]));
    });

    expect(onAttachImage).toHaveBeenCalledWith(file);
    const attachmentList = container.querySelector('[data-testid="issue-chat-composer-attachments"]');
    expect(attachmentList).not.toBeNull();
    expect(attachmentList?.className).toContain("mb-3");
    expect(container.textContent).toContain("report.pdf");
    expect(container.textContent).toContain("Attached to task");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the bottom spacer with zero height until the user has submitted", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[{
              id: "comment-spacer-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "hello",
              authorType: "user",
              presentation: null,
              metadata: null,
              createdAt: new Date("2026-04-22T12:00:00.000Z"),
              updatedAt: new Date("2026-04-22T12:00:00.000Z"),
            }]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const spacer = container.querySelector('[data-testid="issue-chat-bottom-spacer"]') as HTMLDivElement | null;
    expect(spacer).not.toBeNull();
    expect(spacer?.style.height).toBe("0px");

    act(() => {
      root.unmount();
    });
  });

  it("omits the bottom spacer when the composer is hidden", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            showComposer={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const spacer = container.querySelector('[data-testid="issue-chat-bottom-spacer"]');
    expect(spacer).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("hides the reopen control and infers reopen for closed agent-assigned issue replies", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            issueStatus="done"
            currentAssigneeValue="agent:agent-1"
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).not.toContain("Re-open");

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === "Send",
    ) as HTMLButtonElement | undefined;
    expect(editor).not.toBeNull();
    expect(submitButton).toBeDefined();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Please pick this back up");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      submitButton?.click();
    });

    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "Please pick this back up" }],
        runConfig: {
          custom: {
            reopen: true,
          },
        },
      }),
    );

    act(() => {
      root.unmount();
    });
  });

  it("opens a warning dialog before sending a reply with no assignee selected and posts on Send anyway", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableReassign
            reassignOptions={[
              { id: "", label: "No responsible" },
              { id: "agent:agent-1", label: "Agent 1" },
            ]}
            currentAssigneeValue=""
            suggestedAssigneeValue=""
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === "Send",
    ) as HTMLButtonElement | undefined;
    expect(editor).not.toBeNull();
    expect(submitButton).toBeDefined();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Reply without assignee");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      submitButton?.click();
    });

    expect(appendMock).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-testid="issue-chat-no-assignee-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("No responsible selected");
    expect(dialog?.textContent).toContain("no agent will be woken");

    const sendAnyway = document.querySelector(
      '[data-testid="issue-chat-no-assignee-send-anyway"]',
    ) as HTMLButtonElement | null;
    expect(sendAnyway).not.toBeNull();

    await act(async () => {
      sendAnyway?.click();
    });

    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "Reply without assignee" }],
      }),
    );
    expect(document.querySelector('[data-testid="issue-chat-no-assignee-dialog"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("does not post when choosing Go back in the no-assignee warning dialog", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableReassign
            reassignOptions={[
              { id: "", label: "No responsible" },
              { id: "agent:agent-1", label: "Agent 1" },
            ]}
            currentAssigneeValue=""
            suggestedAssigneeValue=""
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === "Send",
    ) as HTMLButtonElement | undefined;

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Reply without assignee");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      submitButton?.click();
    });

    expect(document.querySelector('[data-testid="issue-chat-no-assignee-dialog"]')).not.toBeNull();

    const goBack = document.querySelector(
      '[data-testid="issue-chat-no-assignee-go-back"]',
    ) as HTMLButtonElement | null;
    expect(goBack).not.toBeNull();

    await act(async () => {
      goBack?.click();
    });

    expect(appendMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="issue-chat-no-assignee-dialog"]')).toBeNull();
    // The composer keeps the draft so the user can pick a responsible and resend.
    const editorAfter = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editorAfter?.value).toBe("Reply without assignee");

    act(() => {
      root.unmount();
    });
  });

  it("does not warn when sending a reply with an assignee selected", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableReassign
            reassignOptions={[
              { id: "", label: "No responsible" },
              { id: "agent:agent-1", label: "Agent 1" },
            ]}
            currentAssigneeValue="agent:agent-1"
            suggestedAssigneeValue="agent:agent-1"
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === "Send",
    ) as HTMLButtonElement | undefined;

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Reply with assignee");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      submitButton?.click();
    });

    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("No responsible selected");

    act(() => {
      root.unmount();
    });
  });

  it("exposes a composer focus handle that forwards to the editor", () => {
    const root = createRoot(container);
    const composerRef = createRef<{ focus: () => void; restoreDraft: (submittedBody: string) => void }>();
    const scrollByMock = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const requestAnimationFrameMock = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            composerRef={composerRef}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composerRef.current).not.toBeNull();
    expect(composer).not.toBeNull();

    const scrollIntoViewMock = vi.fn();
    composer!.scrollIntoView = scrollIntoViewMock;

    act(() => {
      composerRef.current?.focus();
    });

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(scrollByMock).toHaveBeenCalledWith({ top: 96, behavior: "smooth" });
    expect(markdownEditorFocusMock).toHaveBeenCalledTimes(1);
    scrollByMock.mockRestore();
    requestAnimationFrameMock.mockRestore();

    act(() => {
      root.unmount();
    });
  });

  it("restores a cancelled queued draft into the composer handle", () => {
    const root = createRoot(container);
    const composerRef = createRef<{ focus: () => void; restoreDraft: (submittedBody: string) => void }>();
    const scrollByMock = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const requestAnimationFrameMock = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            composerRef={composerRef}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor).not.toBeNull();

    act(() => {
      composerRef.current?.restoreDraft("Queued message");
    });

    expect(editor?.value).toBe("Queued message");
    expect(markdownEditorFocusMock).toHaveBeenCalledTimes(1);
    expect(scrollByMock).toHaveBeenCalledWith({ top: 96, behavior: "smooth" });

    scrollByMock.mockRestore();
    requestAnimationFrameMock.mockRestore();
    act(() => {
      root.unmount();
    });
  });

  it("does not restore the composer viewport for passive live updates by default", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[{
              id: "run-1",
              issueId: "issue-1",
              status: "running",
              invocationSource: "comment",
              triggerDetail: null,
              startedAt: "2026-04-06T12:00:00.000Z",
              finishedAt: null,
              createdAt: "2026-04-06T12:00:00.000Z",
              agentId: "agent-1",
              agentName: "Agent 1",
              adapterType: "codex_local",
            }]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(restoreComposerViewportSnapshotMock).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("requests composer viewport restoration when live messages arrive during active composer interaction", () => {
    const root = createRoot(container);
    const scrollByMock = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    shouldPreserveComposerViewportMock.mockReturnValue(true);
    captureComposerViewportSnapshotMock.mockReturnValue({ composerViewportTop: 420 });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[{
              id: "run-1",
              issueId: "issue-1",
              status: "running",
              invocationSource: "comment",
              triggerDetail: null,
              startedAt: "2026-04-06T12:00:00.000Z",
              finishedAt: null,
              createdAt: "2026-04-06T12:00:00.000Z",
              agentId: "agent-1",
              agentName: "Agent 1",
              adapterType: "codex_local",
            }]}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(restoreComposerViewportSnapshotMock).toHaveBeenCalled();

    scrollByMock.mockRestore();
    act(() => {
      root.unmount();
    });
  });

  it("keeps a running chain-of-thought in the Working state between commands", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[{
              id: "run-1",
              issueId: "issue-1",
              status: "running",
              invocationSource: "comment",
              triggerDetail: null,
              startedAt: "2026-04-06T12:00:00.000Z",
              finishedAt: null,
              createdAt: "2026-04-06T12:00:00.000Z",
              agentId: "agent-1",
              agentName: "Agent 1",
              adapterType: "codex_local",
            }]}
            transcriptsByRunId={new Map([
              [
                "run-1",
                [
                  {
                    kind: "tool_call",
                    ts: "2026-04-06T12:00:10.000Z",
                    name: "command_execution",
                    toolUseId: "tool-1",
                    input: { command: "pnpm test" },
                  },
                  {
                    kind: "tool_result",
                    ts: "2026-04-06T12:00:20.000Z",
                    toolUseId: "tool-1",
                    toolName: "command_execution",
                    content: "Tests passed",
                    isError: false,
                  },
                ],
              ],
            ])}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Working");
    expect(container.textContent).not.toContain("Worked");

    act(() => {
      root.unmount();
    });
  });

  it("renders ephemeral active-run status below the working indicator", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            activeRun={{
              id: "run-1",
              issueId: "issue-1",
              status: "running",
              invocationSource: "comment",
              triggerDetail: null,
              startedAt: "2026-04-06T12:00:00.000Z",
              finishedAt: null,
              createdAt: "2026-04-06T12:00:00.000Z",
              agentId: "agent-1",
              agentName: "Agent 1",
              adapterType: "codex_local",
              currentStatusMessage: "Syncing git worktree to sandbox",
              currentStatusUpdatedAt: "2026-04-06T12:00:05.000Z",
              currentToolName: "bash",
              lastEventAt: new Date(Date.now() - 2000).toISOString(),
            }}
            onAdd={async () => {}}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Working...");
    expect(container.textContent).toContain("Using bash");
    expect(container.textContent).not.toContain("last activity");
    expect(container.textContent).toMatch(/\d+ seconds? ago/);

    act(() => {
      root.unmount();
    });
  });

  it("folds chain-of-thought when the same message transitions from running to complete", () => {
    expect(resolveAssistantMessageFoldedState({
      messageId: "message-1",
      currentFolded: false,
      isFoldable: true,
      previousMessageId: "message-1",
      previousIsFoldable: false,
    })).toBe(true);
  });

  it("preserves a manually opened completed message across rerenders", () => {
    expect(resolveAssistantMessageFoldedState({
      messageId: "message-1",
      currentFolded: false,
      isFoldable: true,
      previousMessageId: "message-1",
      previousIsFoldable: true,
    })).toBe(false);
  });

  it("shows the stop-run action for active run-linked messages even without embedded run status", () => {
    expect(canStopIssueChatRun({
      runId: "run-1",
      runStatus: null,
      activeRunIds: new Set(["run-1"]),
    })).toBe(true);
  });

  it("hides the stop-run action for completed historical runs", () => {
    expect(canStopIssueChatRun({
      runId: "run-1",
      runStatus: "cancelled",
      activeRunIds: new Set<string>(),
    })).toBe(false);
  });

  it("uses company profile data to distinguish the current user from other humans", () => {
    const userProfileMap = new Map([
      ["user-1", { label: "Dotta", image: "/avatars/dotta.png" }],
      ["user-2", { label: "Alice", image: "/avatars/alice.png" }],
    ]);

    expect(resolveIssueChatHumanAuthor({
      authorName: "You",
      authorUserId: "user-1",
      currentUserId: "user-1",
      userProfileMap,
    })).toEqual({
      isCurrentUser: true,
      authorName: "Dotta",
      avatarUrl: "/avatars/dotta.png",
    });

    expect(resolveIssueChatHumanAuthor({
      authorName: "Alice",
      authorUserId: "user-2",
      currentUserId: "user-1",
      userProfileMap,
    })).toEqual({
      isCurrentUser: false,
      authorName: "Alice",
      avatarUrl: "/avatars/alice.png",
    });
  });
});
