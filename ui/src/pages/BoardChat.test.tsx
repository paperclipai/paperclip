// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChat } from "./BoardChat";

/**
 * Conference Room transport coverage (PAP-11123). The room is backed by a
 * `board_chat` issue and the real-agent conversation runs over
 * AssistantChat — so the page resolves/mints the backing issue, surfaces
 * history, and hands the resolved issue + CEO default target to the chat
 * surface. The legacy SSE-stream transport assertions are gone.
 */

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockBoardChatApi = vi.hoisted(() => ({
  resolveConversation: vi.fn(),
  getConversation: vi.fn(),
}));
const mockAssistantChatProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockCopyTextToClipboard = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("../api/boardChat", () => ({ boardChatApi: mockBoardChatApi }));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: mockCopyTextToClipboard }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// Heavy children irrelevant to the transport.
vi.mock("../components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));
vi.mock("../components/AssistantChat", () => ({
  AssistantChat: (props: Record<string, unknown>) => {
    mockAssistantChatProps.push(props);
    return (
      <div
        data-testid="selected-agent-chat"
        data-issue-id={String(props.issueId)}
        data-target-agent-id={String(props.targetAgentId)}
      />
    );
  },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="sheet-content">{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await Promise.resolve();
  flushSync(() => {});
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CEO_AGENT = {
  id: "agent-ceo",
  name: "Alex",
  role: "ceo",
  status: "active",
  icon: null,
};
const CTO_AGENT = {
  id: "agent-cto",
  name: "Morgan",
  role: "cto",
  status: "active",
  icon: null,
};
const BOARD_ISSUE = {
  id: "issue-board",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "How is hiring going?",
  originKind: "board_chat",
  originId: "agent-ceo",
  status: "in_progress",
  createdAt: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
};
const LEGACY_BOARD_ISSUE = {
  id: "issue-board-old",
  companyId: "company-1",
  identifier: "PAP-0",
  title: "Board Operations",
  originKind: "board_chat",
  originId: null,
  status: "todo",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

describe("BoardChat Conference Room transport", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient | null = null;
  let currentPath = "";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([CEO_AGENT]);
    mockIssuesApi.list.mockResolvedValue([BOARD_ISSUE]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "sess-1", userId: "user-1" },
      user: { id: "user-1", name: "Board" },
    });
    mockBoardChatApi.resolveConversation.mockResolvedValue({ issue: BOARD_ISSUE });
    mockBoardChatApi.getConversation.mockImplementation(
      async (_companyId: string, ref: string) => ({
        issue:
          ref === LEGACY_BOARD_ISSUE.identifier || ref === LEGACY_BOARD_ISSUE.id
            ? LEGACY_BOARD_ISSUE
            : BOARD_ISSUE,
        unavailableReason: null,
      }),
    );
    mockCopyTextToClipboard.mockResolvedValue(undefined);
    mockAssistantChatProps.length = 0;
    currentPath = "";
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function LocationProbe() {
    const location = useLocation();
    currentPath = `${location.pathname}${location.search}${location.hash}`;
    return null;
  }

  function buildElement(initialPath: string) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <QueryClientProvider client={queryClient!}>
          <LocationProbe />
          <Routes>
            <Route path="/:companyPrefix/board-chat" element={<BoardChat />} />
            <Route path="/:companyPrefix/board-chat/:conversationRef" element={<BoardChat />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  async function render(initialPath = "/PAP/board-chat") {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(buildElement(initialPath));
    });
    // Flush the agent/session/issue queries plus follow-up effect renders.
    await flushEffects();
  }

  async function flushEffects(times = 12) {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  }

  async function waitForPath(path: string, times = 30) {
    for (let i = 0; i < times && currentPath !== path; i++) {
      await flushEffects(1);
    }
  }

  it("loads Conference Room history by board_chat origin", async () => {
    await render();

    expect(mockIssuesApi.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        originKind: "board_chat",
        sortField: "updated",
        sortDir: "desc",
      }),
    );
  });

  it("renders AssistantChat over the resolved board issue with the CEO as default target", async () => {
    await render();

    const surface = container.querySelector(
      '[data-testid="selected-agent-chat"]',
    ) as HTMLDivElement | null;
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("data-issue-id")).toBe(BOARD_ISSUE.id);
    expect(surface?.getAttribute("data-target-agent-id")).toBe(CEO_AGENT.id);

    const lastProps = mockAssistantChatProps.at(-1);
    expect(lastProps?.companyId).toBe("company-1");
    expect(lastProps?.currentUserId).toBe("user-1");
    expect(lastProps?.targetAgentId).toBe(CEO_AGENT.id);
    expect(lastProps?.showAgentSwitcher).toBe(false);
    expect(lastProps?.companyName).toBe("Acme Robotics");
    expect(lastProps?.emptyMessage).toBeUndefined();
    expect(currentPath).toBe("/PAP/board-chat/PAP-1");
  });

  it("mints the first conversation when the company has no history and replaces to its URL", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    mockBoardChatApi.resolveConversation.mockResolvedValue({
      issue: { ...BOARD_ISSUE, id: "issue-minted", identifier: "PAP-2", title: "New chat" },
    });
    await render();

    expect(mockBoardChatApi.resolveConversation).toHaveBeenCalledWith(
      "company-1",
      undefined,
    );
    const surface = container.querySelector(
      '[data-testid="selected-agent-chat"]',
    ) as HTMLDivElement | null;
    expect(surface?.getAttribute("data-issue-id")).toBe("issue-minted");
    await waitForPath("/PAP/board-chat/PAP-2");
    expect(currentPath).toBe("/PAP/board-chat/PAP-2");
  });

  it("forces a fresh conversation when New chat is clicked", async () => {
    mockBoardChatApi.resolveConversation.mockResolvedValue({
      issue: { ...BOARD_ISSUE, id: "issue-fresh", identifier: "PAP-3", title: "New chat" },
    });
    await render();

    const newChatButton = container.querySelector(
      'button[aria-label="new chat"]',
    ) as HTMLButtonElement | null;
    expect(newChatButton).not.toBeNull();

    await act(async () => {
      newChatButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(mockBoardChatApi.resolveConversation).toHaveBeenCalledWith("company-1", {
      newConversation: true,
    });
    const surface = container.querySelector(
      '[data-testid="selected-agent-chat"]',
    ) as HTMLDivElement | null;
    expect(surface?.getAttribute("data-issue-id")).toBe("issue-fresh");
    await flushEffects();
    expect(currentPath).toBe("/PAP/board-chat/PAP-3");
  });

  it("renders the exact direct chat URL after refresh without resolving the latest chat", async () => {
    const directIssue = {
      ...BOARD_ISSUE,
      id: "issue-direct",
      identifier: "PAP-44",
      title: "Budget review",
    };
    mockIssuesApi.list.mockResolvedValue([BOARD_ISSUE]);
    mockBoardChatApi.getConversation.mockResolvedValue({
      issue: directIssue,
      unavailableReason: null,
    });

    await render("/PAP/board-chat/PAP-44");

    expect(mockBoardChatApi.getConversation).toHaveBeenCalledWith("company-1", "PAP-44");
    expect(mockBoardChatApi.resolveConversation).not.toHaveBeenCalled();
    const surface = container.querySelector(
      '[data-testid="selected-agent-chat"]',
    ) as HTMLDivElement | null;
    expect(surface?.getAttribute("data-issue-id")).toBe("issue-direct");
    expect(currentPath).toBe("/PAP/board-chat/PAP-44");
  });

  it("canonicalizes UUID direct links to the issue identifier", async () => {
    mockBoardChatApi.getConversation.mockResolvedValue({
      issue: BOARD_ISSUE,
      unavailableReason: null,
    });

    await render("/PAP/board-chat/issue-board");

    expect(mockBoardChatApi.getConversation).toHaveBeenCalledWith("company-1", "issue-board");
    expect(currentPath).toBe("/PAP/board-chat/PAP-1");
  });

  it("shows an explicit unavailable state for invalid direct links", async () => {
    mockBoardChatApi.getConversation.mockResolvedValue({
      issue: null,
      unavailableReason: "wrong_kind",
    });

    await render("/PAP/board-chat/PAP-99");

    expect(container.textContent).toContain(
      "This link points to an issue, but it is not a Conference Room chat.",
    );
    expect(container.querySelector('[data-testid="selected-agent-chat"]')).toBeNull();
    expect(mockBoardChatApi.resolveConversation).not.toHaveBeenCalled();
  });

  it("history rows navigate by canonical URL", async () => {
    mockIssuesApi.list.mockResolvedValue([
      BOARD_ISSUE,
      { ...LEGACY_BOARD_ISSUE, id: "issue-board-old", identifier: "PAP-0" },
    ]);
    await render();

    const oldChatButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Chat from"),
    ) as HTMLButtonElement | undefined;
    expect(oldChatButton).toBeTruthy();

    await act(async () => {
      oldChatButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(currentPath).toBe("/PAP/board-chat/PAP-0");
  });

  it("copies the canonical link for the current chat", async () => {
    await render();

    const copyButton = container.querySelector(
      'button[aria-label="copy chat link"]',
    ) as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();

    await act(async () => {
      copyButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockCopyTextToClipboard).toHaveBeenCalledWith("http://localhost:3000/PAP/board-chat/PAP-1");
  });

  it("uses a friendly date label for legacy Board Operations history rows", async () => {
    mockIssuesApi.list.mockResolvedValue([LEGACY_BOARD_ISSUE]);
    await render();

    expect(container.textContent).toMatch(/Chat from .*2026/);
    expect(container.textContent).not.toContain("PAP-0");
  });

  it("shows the selected chat agent in history rows", async () => {
    mockAgentsApi.list.mockResolvedValue([CEO_AGENT, CTO_AGENT]);
    mockIssuesApi.list.mockResolvedValue([
      {
        ...BOARD_ISSUE,
        id: "issue-cto-chat",
        originId: CTO_AGENT.id,
        title: "Architecture review",
      },
    ]);
    await render();

    expect(container.textContent).toContain("Architecture review");
    expect(container.textContent).toContain("Morgan · CTO");
  });

  it("reserves mobile viewport height and bottom-nav space for the agent feed", async () => {
    await render();

    const shell = container.querySelector(
      '[data-testid="board-chat-shell"]',
    ) as HTMLDivElement | null;
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain("h-(--sz-calc-43)");
    expect(shell?.className).toContain("-m-4");
    expect(shell?.className).toContain("md:h-(--sz-calc-29)");

    const feedButton = container.querySelector(
      'button[aria-label="Open agent feed"]',
    ) as HTMLButtonElement | null;
    expect(feedButton).not.toBeNull();
    expect(feedButton?.className).toContain(
      "bottom-(--sz-calc-45)",
    );
  });
});
