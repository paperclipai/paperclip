// @vitest-environment jsdom

import { act, createRef, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueChatThread,
  canStopIssueChatRun,
  resolveAssistantMessageFoldedState,
  resolveIssueChatHumanAuthor,
} from "./IssueChatThread";

const { markdownEditorFocusMock } = vi.hoisted(() => ({
  markdownEditorFocusMock: vi.fn(),
}));

const { appendMock } = vi.hoisted(() => ({
  appendMock: vi.fn(async () => undefined),
}));

const { threadMessagesMock } = vi.hoisted(() => ({
  threadMessagesMock: vi.fn(() => <div data-testid="thread-messages" />),
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
  ThreadPrimitive: {
    Root: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div data-testid="thread-root" className={className}>{children}</div>
    ),
    Viewport: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div data-testid="thread-viewport" className={className}>{children}</div>
    ),
    Empty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Messages: () => threadMessagesMock(),
  },
  MessagePrimitive: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Content: () => null,
    Parts: () => null,
  },
  useAui: () => ({ thread: () => ({ append: appendMock }) }),
  useAuiState: () => false,
  useMessage: () => ({
    id: "message",
    role: "assistant",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    content: [],
    metadata: { custom: {} },
    status: { type: "complete" },
  }),
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
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(({
    value = "",
    onChange,
    placeholder,
    className,
    contentClassName,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    className?: string;
    contentClassName?: string;
  }, ref) => {
    useImperativeHandle(ref, () => ({
      focus: markdownEditorFocusMock,
    }));

    return (
      <textarea
        aria-label="Issue chat editor"
        data-class-name={className}
        data-content-class-name={contentClassName}
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

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueChatThread", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    threadMessagesMock.mockImplementation(() => <div data-testid="thread-messages" />);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    appendMock.mockReset();
    markdownEditorFocusMock.mockReset();
    threadMessagesMock.mockReset();
    captureComposerViewportSnapshotMock.mockClear();
    restoreComposerViewportSnapshotMock.mockClear();
    shouldPreserveComposerViewportMock.mockClear();
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
    expect(viewport?.className).not.toContain("max-h-[70vh]");

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

  it("falls back to a safe transcript warning when assistant-ui throws during message rendering", () => {
    const root = createRoot(container);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    threadMessagesMock.mockImplementation(() => {
      throw new Error("tapClientLookup: Index 8 out of bounds (length: 8)");
    });

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

    expect(container.textContent).toContain("Chat renderer hit an internal state error.");
    expect(container.textContent).toContain("Agent summary");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
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

  it("keeps the composer inline with bottom breathing room and a capped editor height", () => {
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

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.className).not.toContain("sticky");
    expect(composer?.className).not.toContain("bottom-0");
    expect(composer?.className).toContain("pb-[calc(env(safe-area-inset-bottom)+1.5rem)]");

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor?.dataset.contentClassName).toContain("max-h-[28dvh]");
    expect(editor?.dataset.contentClassName).toContain("overflow-y-auto");

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
