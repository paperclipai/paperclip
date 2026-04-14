// @vitest-environment jsdom

import { act } from "react";
import { createContext, useContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueChatThread, resolveAssistantMessageFoldedState } from "./IssueChatThread";
import { formatDateTime } from "../lib/utils";

const RuntimeContext = createContext<{ messages?: Array<Record<string, unknown>> }>({});
const MessageContext = createContext<Record<string, unknown> | null>(null);

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({
    runtime,
    children,
  }: {
    runtime: { messages?: Array<Record<string, unknown>> };
    children: ReactNode;
  }) => <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>,
  ActionBarPrimitive: {
    Copy: ({
      children,
      className,
      title,
      "aria-label": ariaLabel,
    }: {
      children: ReactNode;
      className?: string;
      title?: string;
      "aria-label"?: string;
    }) => (
      <button type="button" className={className} title={title} aria-label={ariaLabel} data-copied="false">
        {children}
      </button>
    ),
  },
  ThreadPrimitive: {
    Root: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div data-testid="thread-root" className={className}>{children}</div>
    ),
    Viewport: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div data-testid="thread-viewport" className={className}>{children}</div>
    ),
    Empty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Messages: ({
      components,
    }: {
      components: {
        UserMessage: React.ComponentType;
        AssistantMessage: React.ComponentType;
        SystemMessage: React.ComponentType;
      };
    }) => {
      const runtime = useContext(RuntimeContext);
      const messages = runtime.messages ?? [];

      return (
        <div data-testid="thread-messages">
          {messages.map((message) => {
            const role = message.role;
            const Component = role === "assistant"
              ? components.AssistantMessage
              : role === "system"
                ? components.SystemMessage
                : components.UserMessage;

            return (
              <MessageContext.Provider key={String(message.id)} value={message}>
                <Component />
              </MessageContext.Provider>
            );
          })}
        </div>
      );
    },
  },
  MessagePrimitive: {
    Root: ({ children, id }: { children: ReactNode; id?: string }) => <div id={id}>{children}</div>,
    Content: () => null,
    Parts: ({
      components,
    }: {
      components: {
        Text?: React.ComponentType<{ text: string }>;
      };
    }) => {
      const message = useContext(MessageContext);
      const content = Array.isArray(message?.content) ? message.content : [];

      return (
        <>
          {content.map((part, index) => {
            if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
              const Text = components.Text;
              return Text ? <Text key={index} text={part.text} /> : <div key={index}>{part.text}</div>;
            }
            return null;
          })}
        </>
      );
    },
  },
  useAui: () => ({ thread: () => ({ append: vi.fn() }) }),
  useAuiState: () => false,
  useMessage: () => useContext(MessageContext) ?? {
    id: "message",
    role: "assistant",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    content: [],
    metadata: { custom: {} },
    status: { type: "complete" },
  },
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value = "",
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label="Issue chat editor"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
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
  usePaperclipIssueRuntime: (args: Record<string, unknown>) => args,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("shows absolute header timestamps for both board and agent comments", () => {
    const root = createRoot(container);
    const userCommentAt = new Date("2026-04-06T12:34:00.000Z");
    const agentCommentAt = new Date("2026-04-06T13:45:00.000Z");

    act(() => {
      root.render(
        <MemoryRouter>
          <IssueChatThread
            comments={[
              {
                id: "user-1",
                companyId: "company-1",
                issueId: "issue-1",
                authorAgentId: null,
                authorUserId: "user-1",
                body: "Board update",
                createdAt: userCommentAt,
                updatedAt: userCommentAt,
              },
              {
                id: "agent-1",
                companyId: "company-1",
                issueId: "issue-1",
                authorAgentId: "agent-1",
                authorUserId: null,
                body: "Agent response",
                createdAt: agentCommentAt,
                updatedAt: agentCommentAt,
              },
            ]}
            linkedRuns={[]}
            timelineEvents={[]}
            liveRuns={[]}
            agentMap={new Map([[
              "agent-1",
              {
                id: "agent-1",
                companyId: "company-1",
                name: "CodexCoder",
                urlKey: "codexcoder",
                role: "engineer",
                title: null,
                icon: "code",
                status: "active",
                reportsTo: null,
                capabilities: null,
                adapterType: "process",
                adapterConfig: {},
                runtimeConfig: {},
                budgetMonthlyCents: 0,
                spentMonthlyCents: 0,
                pauseReason: null,
                pausedAt: null,
                permissions: { canCreateAgents: false },
                lastHeartbeatAt: null,
                metadata: null,
                createdAt: userCommentAt,
                updatedAt: userCommentAt,
              },
            ]])}
            currentUserId="user-1"
            onAdd={async () => {}}
            showComposer={false}
            showJumpToLatest={false}
            enableLiveTranscriptPolling={false}
          />
        </MemoryRouter>,
      );
    });

    const userTimestamp = container.querySelector('a[href="#comment-user-1"]') as HTMLAnchorElement | null;
    const agentTimestamp = container.querySelector('a[href="#comment-agent-1"]') as HTMLAnchorElement | null;

    expect(userTimestamp?.textContent).toBe(formatDateTime(userCommentAt));
    expect(agentTimestamp?.textContent).toBe(formatDateTime(agentCommentAt));
    expect(userTimestamp?.className).toContain("rounded-full");
    expect(agentTimestamp?.className).toContain("rounded-full");

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
});
