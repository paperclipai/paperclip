// @vitest-environment jsdom

import type { ReactNode, Ref } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  ASSISTANT_CHAT_ACTIVE_POLL_MS,
  ASSISTANT_CHAT_IDLE_POLL_MS,
  AssistantChat,
  AssistantChatView,
  mergeAssistantChatComments,
  resolveAssistantChatPollInterval,
  resolveDefaultChatTarget,
  type PendingAssistantChatComment,
} from "./AssistantChat";
import type { IssueChatComment } from "../lib/issue-chat-messages";

const mockIssuesApi = vi.hoisted(() => ({
  listComments: vi.fn(),
  listInteractions: vi.fn(),
  get: vi.fn(),
  listFeedbackVotes: vi.fn(),
  addSelectedAgentChatComment: vi.fn(),
  uploadAttachment: vi.fn(),
}));
const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForIssue: vi.fn(),
  activeRunForIssue: vi.fn(),
  cancel: vi.fn(),
}));
const mockComposerDraft = vi.hoisted(() => ({ value: "" }));

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));

// Stub the heavy thread renderer so the View's own wiring (identity header,
// switcher, error/loading states, send pass-through) is what we assert.
vi.mock("./IssueChatThread", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    IssueChatThread: (props: {
    preset?: string;
    comments?: IssueChatComment[];
    emptyMessage?: string;
    emptyState?: ReactNode;
    showJumpToLatest?: boolean;
    composerRef?: Ref<{ setDraft: (body: string) => void; restoreDraft: (body: string) => void; focus: () => void }>;
    onAdd: (b: string) => Promise<void>;
    backgroundWorkChildren?: unknown[];
    suppressIssueStatusNotices?: boolean;
    composerHint?: string | null;
    imageUploadHandler?: (file: File) => Promise<string>;
    onAttachImage?: (file: File) => Promise<unknown>;
  }) => {
    const [draft, setDraft] = React.useState(mockComposerDraft.value || "hello");
    React.useImperativeHandle(props.composerRef, () => ({
      focus: () => {},
      restoreDraft: (body: string) => setDraft(body),
      setDraft: (body: string) => setDraft(body),
    }), []);
    return (
      <div data-testid="issue-chat-thread">
        <span data-testid="thread-preset">{props.preset}</span>
        <span data-testid="empty-message">{props.emptyState ? "" : props.emptyMessage}</span>
        <div data-testid="empty-state">{props.emptyState}</div>
        <span data-testid="jump-to-latest">
          {String(props.showJumpToLatest ?? (props.preset === "assistant" ? false : true))}
        </span>
        <span data-testid="background-work-count">{props.backgroundWorkChildren?.length ?? 0}</span>
        <span data-testid="status-notices">
          {(props.suppressIssueStatusNotices ?? props.preset === "assistant") ? "suppressed" : "visible"}
        </span>
        <span data-testid="composer-hint">
          {props.composerHint}
        </span>
        <span data-testid="image-upload-enabled">{String(Boolean(props.imageUploadHandler))}</span>
        <span data-testid="attach-enabled">{String(Boolean(props.onAttachImage))}</span>
        <span data-testid="composer-draft">{draft}</span>
        <div data-testid="comment-bodies">
          {props.comments?.map((comment) => (
            <span data-testid="comment-body" key={comment.id}>{comment.body}</span>
          ))}
        </div>
        <button
          type="button"
          data-testid="send"
          onClick={() => {
            const submitted = draft;
            setDraft("");
            void props.onAdd(submitted).catch(() => setDraft(submitted));
          }}
        >
          send
        </button>
      </div>
    );
  },
  };
});

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    companyId: "company-1",
    name: "Agent X",
    urlKey: "agent-x",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_code",
    adapterConfig: {},
    runtimeConfig: {} as Agent["runtimeConfig"],
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {} as Agent["permissions"],
    lastHeartbeatAt: null,
    ...overrides,
  } as Agent;
}

const ceo = makeAgent({ id: "agent-ceo", name: "Sarah", role: "ceo" });
const eng = makeAgent({ id: "agent-eng", name: "Dev", role: "engineer" });
const terminated = makeAgent({ id: "agent-dead", name: "Zed", status: "terminated" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeComment(overrides: Partial<IssueChatComment>): IssueChatComment {
  const now = new Date("2026-06-10T00:00:00.000Z");
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user-1",
    createdByRunId: null,
    body: "hello",
    presentation: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as IssueChatComment;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushQueries() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("resolveDefaultChatTarget", () => {
  it("defaults to the CEO", () => {
    expect(resolveDefaultChatTarget([eng, ceo])?.id).toBe("agent-ceo");
  });
  it("honors a preferred agent when present", () => {
    expect(resolveDefaultChatTarget([eng, ceo], "agent-eng")?.id).toBe("agent-eng");
  });
  it("skips terminated preferred and falls back to CEO", () => {
    expect(resolveDefaultChatTarget([ceo, eng, terminated], "agent-dead")?.id).toBe("agent-ceo");
  });
  it("falls back to first active agent when there is no CEO", () => {
    expect(resolveDefaultChatTarget([terminated, eng])?.id).toBe("agent-eng");
  });
  it("returns null for an empty roster", () => {
    expect(resolveDefaultChatTarget([])).toBeNull();
  });
});

describe("AssistantChat helpers", () => {
  it("dedupes an optimistic client-nonce comment once the poll returns the server comment", () => {
    const serverComment = makeComment({ id: "comment-server", body: "hello" });
    const pending: PendingAssistantChatComment = {
      clientNonce: "nonce-1",
      targetAgentId: ceo.id,
      body: "hello",
      serverCommentId: serverComment.id,
      comment: makeComment({
        id: "optimistic:nonce-1",
        body: "hello",
        createdAt: new Date("2026-06-10T00:00:01.000Z"),
      }),
    };

    expect(mergeAssistantChatComments([], [pending]).map((comment) => comment.id)).toEqual([
      "optimistic:nonce-1",
    ]);
    expect(mergeAssistantChatComments([serverComment], [pending]).map((comment) => comment.id)).toEqual([
      "comment-server",
    ]);
  });

  it("switches the polling interval between idle and live run cadences", () => {
    expect(resolveAssistantChatPollInterval(false)).toBe(ASSISTANT_CHAT_IDLE_POLL_MS);
    expect(resolveAssistantChatPollInterval(true)).toBe(ASSISTANT_CHAT_ACTIVE_POLL_MS);
  });
});

describe("AssistantChat", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockComposerDraft.value = "hello";
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listInteractions.mockResolvedValue([]);
    mockIssuesApi.get.mockResolvedValue({ id: "issue-1", blockedBy: [], blocks: [] });
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  function renderConnected() {
    queryClient.setQueryData(["issues", "comments", "issue-1"], []);
    queryClient.setQueryData(["issues", "interactions", "issue-1"], []);
    queryClient.setQueryData(["issues", "detail", "issue-1"], { id: "issue-1", blockedBy: [], blocks: [] });
    queryClient.setQueryData(["issues", "feedback-votes", "issue-1"], []);
    queryClient.setQueryData(["issues", "live-runs", "issue-1", "agent", ceo.id], []);
    queryClient.setQueryData(["issues", "active-run", "issue-1", "agent", ceo.id], null);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AssistantChat
            issueId="issue-1"
            companyId="company-1"
            agents={[ceo]}
            targetAgentId={ceo.id}
            currentUserId="user-1"
          />
        </QueryClientProvider>,
      );
    });
  }

  it("appends an optimistic user comment and dedupes when polled data includes the server comment", async () => {
    const createdComment = makeComment({ id: "comment-server", body: "hello" });
    const deferred = createDeferred<{ comment: IssueChatComment; targetAgent: { id: string; name: string; role: string; status: string } }>();
    mockIssuesApi.addSelectedAgentChatComment.mockReturnValue(deferred.promise);

    renderConnected();
    await flushQueries();

    const send = container.querySelector('[data-testid="send"]') as HTMLButtonElement;
    flushSync(() => send.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushQueries();

    expect(Array.from(container.querySelectorAll('[data-testid="comment-body"]')).map((el) => el.textContent)).toEqual([
      "hello",
    ]);

    deferred.resolve({
      comment: createdComment,
      targetAgent: { id: ceo.id, name: ceo.name, role: ceo.role, status: ceo.status },
    });
    await flushQueries();
    queryClient.setQueryData(["issues", "comments", "issue-1"], [createdComment]);
    await flushQueries();

    expect(Array.from(container.querySelectorAll('[data-testid="comment-body"]')).map((el) => el.textContent)).toEqual([
      "hello",
    ]);
  });

  it("preserves the submitted draft and shows an error when send fails", async () => {
    mockComposerDraft.value = "keep this";
    mockIssuesApi.addSelectedAgentChatComment.mockRejectedValue(new Error("Delivery failed"));

    renderConnected();
    await flushQueries();

    const send = container.querySelector('[data-testid="send"]') as HTMLButtonElement;
    flushSync(() => send.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushQueries();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Delivery failed");
    expect(container.querySelector('[data-testid="composer-draft"]')?.textContent).toBe("keep this");
    expect(container.querySelectorAll('[data-testid="comment-body"]')).toHaveLength(0);
  });
});

describe("AssistantChatView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockComposerDraft.value = "";
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(node: ReactNode) {
    flushSync(() => root.render(node));
  }

  function countText(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  it("renders the real selected-agent identity in the header", () => {
    render(
      <AssistantChatView
        agents={[ceo, eng]}
        targetAgentId={ceo.id}
        comments={[]}
        onSend={async () => {}}
      />,
    );
    expect(container.textContent).toContain("Sarah");
    expect(container.textContent).toContain("CEO");
    // No board-concierge persona leaks into the surface.
    expect(container.textContent?.toLowerCase()).not.toContain("concierge");
  });

  it("uses the left-side selector as the selected-agent identity without repeating the role", () => {
    render(
      <AssistantChatView
        agents={[ceo, eng]}
        targetAgentId={ceo.id}
        comments={[]}
        onSend={async () => {}}
        onTargetAgentChange={() => {}}
      />,
    );

    const header = container.querySelector(
      '[data-testid="selected-agent-chat-header"]',
    ) as HTMLDivElement | null;
    const switcher = header?.querySelector('[aria-label="Choose chat agent"]');
    expect(switcher).not.toBeNull();
    expect(switcher?.textContent).toContain("Sarah");
    expect(countText(switcher?.textContent ?? "", "CEO")).toBe(1);
    expect(header?.textContent).toBe(switcher?.textContent);
  });

  it("pads the chat body to align with the selected-agent header", () => {
    render(
      <AssistantChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        onSend={async () => {}}
      />,
    );

    const body = container.querySelector(
      '[data-testid="selected-agent-chat-body"]',
    ) as HTMLDivElement | null;
    expect(body).not.toBeNull();
    expect(body?.className).toContain("px-4");
    expect(body?.className).toContain("pt-3");
    expect(body?.className).toContain("pb-4");
  });

  it("shows a loading indicator while the first fetch is in flight", () => {
    render(
      <AssistantChatView agents={[ceo]} targetAgentId={ceo.id} comments={[]} loading onSend={async () => {}} />,
    );
    expect(container.querySelector('[aria-label="Loading conversation"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="issue-chat-thread"]')).toBeNull();
  });

  it("surfaces a delivery error with a Try again affordance", () => {
    const onRetry = vi.fn();
    render(
      <AssistantChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        errorText="Could not deliver."
        onRetry={onRetry}
        onSend={async () => {}}
      />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not deliver.");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Try again",
    );
    expect(retry).toBeTruthy();
    flushSync(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("passes a target-specific empty message and pipes sends through", async () => {
    const onSend = vi.fn(async () => {});
    render(
      <AssistantChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        starterPrompts={[]}
        onSend={onSend}
      />,
    );
    expect(container.querySelector('[data-testid="empty-message"]')?.textContent).toContain(
      "Sarah",
    );
    const send = container.querySelector('[data-testid="send"]') as HTMLButtonElement;
    flushSync(() => send.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("forwards Conference Room background-work state to the issue thread", () => {
    render(
      <AssistantChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        backgroundWorkChildren={[
          {
            id: "issue-child",
            identifier: "PAP-2",
            title: "Background task",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: ceo.id,
            assigneeUserId: null,
          },
        ]}
        suppressIssueStatusNotices
        composerHint="Ask me anything while I work on this."
        onSend={async () => {}}
      />,
    );

    expect(container.querySelector('[data-testid="background-work-count"]')?.textContent).toBe("1");
    expect(container.querySelector('[data-testid="status-notices"]')?.textContent).toBe("suppressed");
    expect(container.querySelector('[data-testid="composer-hint"]')?.textContent).toBe(
      "Ask me anything while I work on this.",
    );
  });

  it("does not add conference-room shortcut guidance when no custom hint is provided", () => {
    render(
      <AssistantChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        starterPrompts={[]}
        onSend={async () => {}}
      />,
    );

    expect(container.querySelector('[data-testid="composer-hint"]')?.textContent).toBe("");
  });

  it("renders assistant starter prompts without the large start-message placeholder", () => {
    render(
      <AssistantChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        companyName="Acme Robotics"
        onSend={async () => {}}
      />,
    );

    expect(container.textContent).toContain("Draft a Company Brief");
    expect(container.textContent).toContain("Create a hiring plan");
    expect(container.textContent).toContain("Outline our first 30 days");
    expect(container.textContent).toContain("Write an intro pitch");
    expect(container.querySelector('[data-testid="empty-message"]')?.textContent).not.toContain(
      "Send Sarah a message to start the conversation.",
    );
    expect(container.querySelector('[data-testid="jump-to-latest"]')?.textContent).toBe("false");
    expect(container.querySelector('[data-testid="thread-preset"]')?.textContent).toBe("assistant");
    expect(container.querySelector('[data-testid="status-notices"]')?.textContent).toBe("suppressed");
  });

  it("forwards attachment handlers to the shared issue chat composer", () => {
    render(
      <AssistantChatView
        agents={[ceo]}
        targetAgentId={ceo.id}
        comments={[]}
        imageUploadHandler={async () => "/api/attachments/image/content"}
        onAttachImage={async () => undefined}
        onSend={async () => {}}
      />,
    );

    expect(container.querySelector('[data-testid="image-upload-enabled"]')?.textContent).toBe("true");
    expect(container.querySelector('[data-testid="attach-enabled"]')?.textContent).toBe("true");
  });

  it("offers the switcher only when more than one agent is invokable", () => {
    render(
      <AssistantChatView agents={[ceo]} targetAgentId={ceo.id} comments={[]} onSend={async () => {}} onTargetAgentChange={() => {}} />,
    );
    expect(container.querySelector('[aria-label="Choose chat agent"]')).toBeNull();

    render(
      <AssistantChatView
        agents={[ceo, eng]}
        targetAgentId={ceo.id}
        comments={[] as IssueChatComment[]}
        onSend={async () => {}}
        onTargetAgentChange={() => {}}
      />,
    );
    expect(container.querySelector('[aria-label="Choose chat agent"]')).not.toBeNull();
  });
});
