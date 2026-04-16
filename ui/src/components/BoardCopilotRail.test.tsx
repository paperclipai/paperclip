// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardCopilotRail } from "./BoardCopilotRail";

const SESSION_KEY = "paperclip:board-copilot-session";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: true,
}));

const locationState = vi.hoisted(() => ({
  pathname: "/dashboard",
  search: "",
  hash: "",
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockCopilotApi = vi.hoisted(() => ({
  getThread: vi.fn(),
  listThreads: vi.fn(),
  sendMessage: vi.fn(),
  createThread: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  listComments: vi.fn(),
}));

const mockActivityApi = vi.hoisted(() => ({
  runsForIssue: vi.fn(),
  forIssue: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForIssue: vi.fn(),
  activeRunForIssue: vi.fn(),
  cancel: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => locationState,
}));

vi.mock("../api/copilot", () => ({
  copilotApi: mockCopilotApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/activity", () => ({
  activityApi: mockActivityApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../lib/copilot-route-context", () => ({
  buildCopilotRouteContext: () => ({
    pageKind: locationState.pathname.slice(1) || "dashboard",
    pagePath: `${locationState.pathname}${locationState.search}`,
    entityType: null,
    entityId: null,
  }),
  extractContextIssueRef: () => null,
}));

vi.mock("../lib/issue-timeline-events", () => ({
  extractIssueTimelineEvents: () => [],
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./IssueChatThread", () => ({
  IssueChatThread: () => <div>Copilot thread</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderRail(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BoardCopilotRail />
      </QueryClientProvider>,
    );
  });

  const rerender = () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BoardCopilotRail />
        </QueryClientProvider>,
      );
    });
  };

  return { root, rerender };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("BoardCopilotRail mobile access", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    window.sessionStorage.clear();

    locationState.pathname = "/dashboard";
    locationState.search = "";
    locationState.hash = "";

    toastState.pushToast.mockReset();
    mockCopilotApi.getThread.mockReset();
    mockCopilotApi.listThreads.mockReset();
    mockCopilotApi.sendMessage.mockReset();
    mockCopilotApi.createThread.mockReset();
    mockIssuesApi.listComments.mockReset();
    mockActivityApi.runsForIssue.mockReset();
    mockActivityApi.forIssue.mockReset();
    mockHeartbeatsApi.liveRunsForIssue.mockReset();
    mockHeartbeatsApi.activeRunForIssue.mockReset();
    mockHeartbeatsApi.cancel.mockReset();
    mockAgentsApi.list.mockReset();
    mockAuthApi.getSession.mockReset();

    mockCopilotApi.getThread.mockResolvedValue({ issueId: "issue-1", issueStatus: "todo" });
    mockCopilotApi.listThreads.mockResolvedValue([]);
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockActivityApi.runsForIssue.mockResolvedValue([]);
    mockActivityApi.forIssue.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { userId: "user-1" } });
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a mobile chat launcher and opens the copilot sheet", async () => {
    const { root } = renderRail(container);
    await flush();

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Chat"),
    ) as HTMLButtonElement | undefined;

    expect(openButton).toBeDefined();

    act(() => {
      openButton?.click();
    });

    await flush();

    expect(container.textContent).toContain("Board Copilot");
    expect(container.textContent).toContain("New chat");

    act(() => {
      root.unmount();
    });
  });

  it("starts a new chat when opening from a fresh route session", async () => {
    mockCopilotApi.createThread.mockResolvedValue({
      issueId: "issue-2",
      issueIdentifier: "PAP-901",
      issueTitle: "Board Copilot Thread",
      issueStatus: "todo",
      issuePriority: "high",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      threadOwnerUserId: "user-1",
      updatedAt: "2026-04-12T10:02:00.000Z",
    });

    const { root } = renderRail(container);
    await flush();

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Chat"),
    ) as HTMLButtonElement | undefined;

    act(() => {
      openButton?.click();
    });

    await flush();
    await flush();

    expect(mockCopilotApi.createThread).toHaveBeenCalledWith("company-1", {
      contextIssueId: null,
    });
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe("company-1::/dashboard");

    act(() => {
      root.unmount();
    });
  });

  it("reuses the current thread when reopening the same route session", async () => {
    window.sessionStorage.setItem(SESSION_KEY, "company-1::/dashboard");

    const { root } = renderRail(container);
    await flush();

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Chat"),
    ) as HTMLButtonElement | undefined;

    act(() => {
      openButton?.click();
    });

    await flush();

    expect(mockCopilotApi.createThread).not.toHaveBeenCalled();
    expect(mockCopilotApi.getThread).toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("starts a new chat when the route changes to a different session", async () => {
    mockCopilotApi.createThread.mockResolvedValue({
      issueId: "issue-2",
      issueIdentifier: "PAP-901",
      issueTitle: "Board Copilot Thread",
      issueStatus: "todo",
      issuePriority: "high",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      threadOwnerUserId: "user-1",
      updatedAt: "2026-04-12T10:02:00.000Z",
    });

    const { root, rerender } = renderRail(container);
    await flush();

    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Chat"),
    ) as HTMLButtonElement | undefined;

    act(() => {
      openButton?.click();
    });

    await flush();
    await flush();

    expect(mockCopilotApi.createThread).toHaveBeenCalledTimes(1);

    locationState.pathname = "/agents";
    rerender();
    await flush();
    await flush();

    expect(mockCopilotApi.createThread).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe("company-1::/agents");

    act(() => {
      root.unmount();
    });
  });
});
