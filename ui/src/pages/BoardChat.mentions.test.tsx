// @vitest-environment jsdom

import { act, forwardRef } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChat } from "./BoardChat";

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listComments: vi.fn(),
  listFeedbackVotes: vi.fn(),
  uploadAttachment: vi.fn(),
}));
const mockDialogState = vi.hoisted(() => ({ onboardingOpen: false }));
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogState: () => ({ onboardingOpen: mockDialogState.onboardingOpen }),
}));

vi.mock("../components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./board-chat/BoardChatComposer", () => ({
  BoardChatComposer: forwardRef(
    (
      {
        mentions,
        onChange,
        onSubmit,
        canAttach,
        onAttachFile,
      }: {
        mentions?: Array<{ name: string }>;
        onChange?: (value: string) => void;
        onSubmit?: () => void;
        canAttach?: boolean;
        onAttachFile?: (file: File) => Promise<void>;
      },
      _ref,
    ) => (
      <div data-testid="markdown-editor">
        <span data-testid="composer-placeholder">
          Mensagem à sala… use @ para chamar um agente
        </span>
        <span data-testid="mention-count">{mentions?.length ?? 0}</span>
        <button
          type="button"
          data-testid="composer-submit"
          onClick={() => {
            onChange?.("hello room");
            queueMicrotask(() => onSubmit?.());
          }}
        >
          Send
        </button>
        <button
          type="button"
          data-testid="composer-attach"
          disabled={!canAttach}
          onClick={() => {
            void onAttachFile?.(new File(["x"], "note.txt", { type: "text/plain" }));
          }}
        >
          Attach
        </button>
      </div>
    ),
  ),
}));
vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForIssue: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("../components/AgentBubbleActionRow", () => ({
  AgentBubbleActionRow: () => null,
  agentBubbleDateLabel: () => "",
}));
vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("BoardChat mentions composer (P0)", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as typeof fetch;
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-ceo", name: "CEO", role: "ceo", status: "idle", icon: null },
      { id: "agent-dev", name: "Dev", role: "engineer", status: "idle", icon: null },
    ]);
    mockGoalsApi.list.mockResolvedValue([]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listComments.mockResolvedValue([
      {
        id: "comment-1",
        body: "hello",
        authorAgentId: null,
        authorUserId: "user-1",
        createdAt: new Date().toISOString(),
      },
    ]);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockDialogState.onboardingOpen = false;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  function renderBoardChat() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BoardChat />
        </QueryClientProvider>,
      );
    });
  }

  it("renders MarkdownEditor with silent-until-@ placeholder and agent mentions", async () => {
    renderBoardChat();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-editor"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="mention-count"]')?.textContent).toBe("2");
    });

    const placeholder = container.querySelector('[data-testid="composer-placeholder"]');
    expect(placeholder?.textContent).toContain("@");
  });

  it("posts JSON to board chat stream without expecting SSE", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        mode: "silent",
        issueId: "issue-1",
        commentId: "comment-2",
        roomMessageId: "comment-2",
      }),
    });

    renderBoardChat();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="composer-submit"]')).toBeTruthy();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="composer-submit"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/board/chat/stream",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("uploads attachments via issuesApi.uploadAttachment when Board Operations issue exists", async () => {
    mockIssuesApi.list.mockResolvedValue([
      {
        id: "issue-board-ops",
        title: "Board Operations",
        status: "todo",
        identifier: "PAP-1",
      },
    ]);
    mockIssuesApi.uploadAttachment.mockResolvedValue({
      id: "att-1",
      contentPath: "/api/attachments/att-1/content",
    });

    renderBoardChat();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="composer-attach"]')).toBeTruthy();
      expect(
        container.querySelector<HTMLButtonElement>('[data-testid="composer-attach"]')?.disabled,
      ).toBe(false);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="composer-attach"]')?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledWith(
        "company-1",
        "issue-board-ops",
        expect.any(File),
      );
    });
  });
});
