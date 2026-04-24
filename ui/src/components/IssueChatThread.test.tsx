// @vitest-environment jsdom

import { act, createRef, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  IssueChatThread,
  canStopIssueChatRun,
  resolveAssistantMessageFoldedState,
  resolveIssueChatHumanAuthor,
} from "./IssueChatThread";
import type {
  AskUserQuestionsInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";

const { markdownEditorFocusMock } = vi.hoisted(() => ({
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
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
      prompt: "Approve the plan and let the assignee start implementation?",
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

    expect(container.textContent).toContain("Work on this issue is blocked by the linked issue");
    expect(container.textContent).toContain("Comments still wake the assignee for questions or triage");
    expect(container.textContent).toContain("PAP-1723");
    expect(container.textContent).toContain("QA the install flow");
    expect(container.querySelector('[data-issue-path-id="PAP-1723"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("shows paused assigned agent context above the composer", () => {
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
    expect(dock?.className).toContain("bottom-[calc(env(safe-area-inset-bottom)+20px)]");
    expect(dock?.className).toContain("z-20");

    const composer = container.querySelector('[data-testid="issue-chat-composer"]') as HTMLDivElement | null;
    expect(composer).not.toBeNull();
    expect(composer?.className).toContain("rounded-md");
    expect(composer?.className).not.toContain("rounded-lg");
    expect(composer?.className).toContain("p-[15px]");

    const editor = container.querySelector('textarea[aria-label="Issue chat editor"]') as HTMLTextAreaElement | null;
    expect(editor?.dataset.contentClassName).toContain("max-h-[28dvh]");
    expect(editor?.dataset.contentClassName).toContain("overflow-y-auto");
    expect(editor?.dataset.contentClassName).not.toContain("min-h-[72px]");
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
    expect(container.textContent).toContain("Other files are added to this issue");
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
    expect(container.textContent).toContain("Attached to issue");

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
    expect(container.textContent).toContain("Attached to issue");

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
