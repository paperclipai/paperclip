// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarRecentTasks } from "./SidebarRecentTasks";
import {
  getRecentTasksStorageKey,
  readRecentTasks,
  recordRecentTask,
} from "@/lib/recent-tasks";

const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, ...props }: {
    children: ReactNode;
    to: string;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    collapsed: false,
    peeking: false,
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarRecentTasks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    mockIssuesApi.get.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", name: "Board", email: "board@example.test", image: null },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarRecentTasks companyId="company-1" liveIssueIds={new Set(["issue-1"])} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    });
    return queryClient;
  }

  it("renders a compact empty state", async () => {
    await render();
    expect(container.textContent).toContain("Recent Tasks");
    expect(container.textContent).toContain("Open or create a task");
  });

  it("renders refreshed task text and live state without shifting for a status icon", async () => {
    recordRecentTask({
      id: "issue-1",
      companyId: "company-1",
      title: "Initial title",
      identifier: "PAP-1",
      status: "todo",
      updatedAt: new Date(1),
    }, "user-1");
    mockIssuesApi.get.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Refreshed title",
      identifier: "PAP-1",
      status: "in_progress",
      hiddenAt: null,
      updatedAt: new Date(2),
    });

    const queryClient = await render();
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    });

    const link = container.querySelector('a[href="/issues/issue-1"]');
    expect(mockIssuesApi.get).toHaveBeenCalledWith("issue-1");
    expect(queryClient.getQueryData(["issues", "detail", "issue-1"])).toMatchObject({
      title: "Refreshed title",
    });
    expect(link?.textContent).toContain("Refreshed title");
    expect(link?.textContent).toContain("1 live");
    expect(link?.querySelector('[aria-label="In Progress"]')).toBeNull();
    expect(link?.querySelector('[data-slot="recent-task-icon-spacer"]')).toBeNull();
    expect(link?.querySelector('[data-slot="sidebar-nav-icon"]')).toBeNull();
    expect(link?.firstElementChild?.textContent).toBe("Refreshed title");
  });

  it("synchronizes recent tasks written by another tab", async () => {
    mockIssuesApi.get.mockImplementation(() => new Promise(() => {}));
    await render();
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    const entries = [{
      id: "issue-2",
      companyId: "company-1",
      title: "Cross-tab task",
      identifier: "PAP-2",
      status: "todo" as const,
      recordedAt: 2,
    }];

    await act(async () => {
      window.localStorage.setItem(storageKey, JSON.stringify(entries));
      window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
      await Promise.resolve();
    });

    expect(container.querySelector('a[href="/issues/issue-2"]')?.textContent).toContain("Cross-tab task");
  });

  it("prunes tasks that become hidden", async () => {
    recordRecentTask({
      id: "issue-hidden",
      companyId: "company-1",
      title: "Hidden task",
      identifier: "PAP-3",
      status: "todo",
      updatedAt: new Date(3),
    }, "user-1");
    mockIssuesApi.get.mockResolvedValue({
      id: "issue-hidden",
      companyId: "company-1",
      title: "Hidden task",
      identifier: "PAP-3",
      status: "todo",
      hiddenAt: new Date(),
      updatedAt: new Date(4),
    });

    await render();
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector('a[href="/issues/issue-hidden"]')).toBeNull();
    expect(readRecentTasks(
      getRecentTasksStorageKey("company-1", "user-1"),
      "company-1",
    )).toEqual([]);
  });
});
