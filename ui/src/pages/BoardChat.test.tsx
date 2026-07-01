// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChat } from "./BoardChat";

/**
 * Conference Room transport coverage (PAP-11123). The room is backed by a
 * `board_chat` issue and the real-agent conversation runs over
 * SelectedAgentChat — so the page resolves/mints the backing issue, surfaces
 * history, and hands the resolved issue + CEO default target to the chat
 * surface. The legacy SSE-stream transport assertions are gone.
 */

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockBoardChatApi = vi.hoisted(() => ({ resolveConversation: vi.fn() }));
const mockSelectedAgentChatProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("../api/boardChat", () => ({ boardChatApi: mockBoardChatApi }));

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
vi.mock("../components/SelectedAgentChat", () => ({
  SelectedAgentChat: (props: Record<string, unknown>) => {
    mockSelectedAgentChatProps.push(props);
    return (
      <div
        data-testid="selected-agent-chat"
        data-issue-id={String(props.issueId)}
        data-default-target={String(props.defaultTargetAgentId)}
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
    mockSelectedAgentChatProps.length = 0;
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

  function buildElement() {
    return (
      <QueryClientProvider client={queryClient!}>
        <BoardChat />
      </QueryClientProvider>
    );
  }

  async function render() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(buildElement());
    });
    // Flush the agent/session/issue queries plus follow-up effect renders.
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
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

  it("renders SelectedAgentChat over the resolved board issue with the CEO as default target", async () => {
    await render();

    const surface = container.querySelector(
      '[data-testid="selected-agent-chat"]',
    ) as HTMLDivElement | null;
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("data-issue-id")).toBe(BOARD_ISSUE.id);
    expect(surface?.getAttribute("data-default-target")).toBe(CEO_AGENT.id);

    const lastProps = mockSelectedAgentChatProps.at(-1);
    expect(lastProps?.companyId).toBe("company-1");
    expect(lastProps?.currentUserId).toBe("user-1");
    expect(lastProps?.conferenceRoomMode).toBe(true);
    expect(lastProps?.showAgentSwitcher).toBe(false);
    expect(lastProps?.companyName).toBe("Acme Robotics");
    expect(lastProps?.emptyMessage).toBeUndefined();
  });

  it("mints the first conversation when the company has no history", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    mockBoardChatApi.resolveConversation.mockResolvedValue({
      issue: { ...BOARD_ISSUE, id: "issue-minted", title: "New chat" },
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
  });

  it("forces a fresh conversation when New chat is clicked", async () => {
    mockBoardChatApi.resolveConversation.mockResolvedValue({
      issue: { ...BOARD_ISSUE, id: "issue-fresh", title: "New chat" },
    });
    await render();

    const newChatButton = container.querySelector(
      'button[aria-label="new chat"]',
    ) as HTMLButtonElement | null;
    expect(newChatButton).not.toBeNull();

    await act(async () => {
      newChatButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    expect(mockBoardChatApi.resolveConversation).toHaveBeenCalledWith("company-1", {
      newConversation: true,
    });
    const surface = container.querySelector(
      '[data-testid="selected-agent-chat"]',
    ) as HTMLDivElement | null;
    expect(surface?.getAttribute("data-issue-id")).toBe("issue-fresh");
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
    expect(shell?.className).toContain("h-[calc(100dvh_-_3rem_-_4rem");
    expect(shell?.className).toContain("env(safe-area-inset-top)");
    expect(shell?.className).toContain("env(safe-area-inset-bottom)");
    expect(shell?.className).toContain("-m-4");
    expect(shell?.className).toContain("md:h-[calc(100%_+_3rem)]");

    const feedButton = container.querySelector(
      'button[aria-label="Open agent feed"]',
    ) as HTMLButtonElement | null;
    expect(feedButton).not.toBeNull();
    expect(feedButton?.className).toContain(
      "bottom-[calc(5rem_+_env(safe-area-inset-bottom))]",
    );
  });
});
