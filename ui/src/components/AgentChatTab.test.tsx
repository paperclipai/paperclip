// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatTab } from "./AgentChatTab";

const mockAgentsApi = vi.hoisted(() => ({
  threadMessages: vi.fn(),
  postThreadMessage: vi.fn(),
  markThreadRead: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const threadPropsSpy = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("./IssueChatThread", () => ({
  IssueChatThread: (props: {
    comments: Array<{ body: string }>;
    showComposer?: boolean;
    emptyMessage?: string;
    onAdd: (body: string) => Promise<void>;
  }) => {
    threadPropsSpy(props);
    return (
      <div>
        <div data-testid="comment-count">{String(props.comments.length)}</div>
        <div data-testid="show-composer">{String(props.showComposer)}</div>
        <div data-testid="empty-message">{props.emptyMessage}</div>
        <button type="button" onClick={() => void props.onAdd("new message")}>send</button>
      </div>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: new Date("2026-05-04T09:00:00.000Z"),
    finishedAt: new Date("2026-05-04T09:01:00.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: 0,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 0,
    scheduledRetryReason: null,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: { agentThreadId: "thread-1" },
    createdAt: new Date("2026-05-04T09:00:00.000Z"),
    updatedAt: new Date("2026-05-04T09:01:00.000Z"),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {node}
      </QueryClientProvider>,
    );
  });

  return { root };
}

describe("AgentChatTab", () => {
  let container: HTMLDivElement;
  let cleanup: { root: { unmount: () => void } } | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    cleanup = null;
    threadPropsSpy.mockReset();
    mockAgentsApi.threadMessages.mockReset();
    mockAgentsApi.postThreadMessage.mockReset();
    mockAgentsApi.markThreadRead.mockReset();
    mockHeartbeatsApi.liveRunsForCompany.mockReset();

    mockAgentsApi.threadMessages.mockResolvedValue({
      thread: {
        id: "thread-1",
        companyId: "company-1",
        agentId: "agent-1",
        status: "active",
        archivedAt: null,
        lastActivityAt: new Date("2026-05-04T09:00:00.000Z"),
        createdAt: new Date("2026-05-04T09:00:00.000Z"),
        updatedAt: new Date("2026-05-04T09:00:00.000Z"),
      },
      messages: [
        {
          id: "message-1",
          threadId: "thread-1",
          companyId: "company-1",
          role: "user",
          authorUserId: "user-1",
          authorAgentId: null,
          producingHeartbeatRunId: null,
          body: "hello from board",
          createdAt: new Date("2026-05-04T09:00:00.000Z"),
          updatedAt: new Date("2026-05-04T09:00:00.000Z"),
        },
      ],
    });
    mockAgentsApi.postThreadMessage.mockResolvedValue({
      thread: {
        id: "thread-1",
        companyId: "company-1",
        agentId: "agent-1",
        status: "active",
        archivedAt: null,
        lastActivityAt: new Date("2026-05-04T09:01:00.000Z"),
        createdAt: new Date("2026-05-04T09:00:00.000Z"),
        updatedAt: new Date("2026-05-04T09:01:00.000Z"),
      },
      message: {
        id: "message-2",
        threadId: "thread-1",
        companyId: "company-1",
        role: "user",
        authorUserId: "user-1",
        authorAgentId: null,
        producingHeartbeatRunId: null,
        body: "new message",
        createdAt: new Date("2026-05-04T09:01:00.000Z"),
        updatedAt: new Date("2026-05-04T09:01:00.000Z"),
      },
    });
    mockAgentsApi.markThreadRead.mockResolvedValue({
      thread: {
        id: "thread-1",
        companyId: "company-1",
        agentId: "agent-1",
        status: "active",
        archivedAt: null,
        lastActivityAt: new Date("2026-05-04T09:01:00.000Z"),
        createdAt: new Date("2026-05-04T09:00:00.000Z"),
        updatedAt: new Date("2026-05-04T09:01:00.000Z"),
      },
      readState: {
        id: "read-1",
        threadId: "thread-1",
        companyId: "company-1",
        userId: "user-1",
        lastReadMessageId: "message-2",
        lastReadAt: new Date("2026-05-04T09:01:00.000Z"),
        createdAt: new Date("2026-05-04T09:01:00.000Z"),
        updatedAt: new Date("2026-05-04T09:01:00.000Z"),
      },
    });
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      cleanup?.root.unmount();
    });
    container.remove();
  });

  it("loads agent thread messages and enables composer", async () => {
    cleanup = renderWithQueryClient(
      <AgentChatTab
        agentId="agent-1"
        companyId="company-1"
        runs={[createRun()]}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockAgentsApi.threadMessages).toHaveBeenCalledWith("agent-1", "company-1");
      expect(threadPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          comments: [
            expect.objectContaining({
              body: "hello from board",
            }),
          ],
        }),
      );
    });

    expect(container.textContent).toContain("1");
    expect(container.textContent).toContain("true");
    expect(container.textContent).toContain("Start direct conversation with this agent.");
  });

  it("posts through nested agent thread endpoint from composer", async () => {
    cleanup = renderWithQueryClient(
      <AgentChatTab
        agentId="agent-1"
        companyId="company-1"
        runs={[createRun()]}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(threadPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          comments: [
            expect.objectContaining({
              body: "hello from board",
            }),
          ],
        }),
      );
    });

    const button = container.querySelector("button");
    if (!button) throw new Error("send button missing");

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(mockAgentsApi.postThreadMessage).toHaveBeenCalledWith("agent-1", "new message", "company-1");
    expect(mockAgentsApi.markThreadRead).toHaveBeenCalledWith(
      "agent-1",
      { lastReadMessageId: "message-2" },
      "company-1",
    );
  });
});
