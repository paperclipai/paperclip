// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    issuePrefix: "PAP",
    brandColor: null,
  },
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  sidebarSide: "left",
  setSidebarOpen: vi.fn(),
}));

const heartbeatsApiMock = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const sidebarBadgesApiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({
    to,
    children,
    className,
    state: _state,
    end: _end,
    ...props
  }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
    state?: unknown;
    end?: boolean;
  }) => {
    const linkState = { isActive: false };
    return (
      <a
        href={to}
        className={typeof className === "function" ? className(linkState) : className}
        {...props}
      >
        {typeof children === "function" ? children(linkState) : children}
      </a>
    );
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: heartbeatsApiMock,
}));

vi.mock("../api/sidebarBadges", () => ({
  sidebarBadgesApi: sidebarBadgesApiMock,
}));

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => <div data-testid="sidebar-projects" />,
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: () => <div data-testid="sidebar-agents" />,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

function linkByHref(href: string) {
  return container?.querySelector(`a[href="${href}"]`) as HTMLAnchorElement | null;
}

async function renderSidebar() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Sidebar />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  dialogState.openNewIssue.mockReset();
  sidebarState.setSidebarOpen.mockReset();
  heartbeatsApiMock.liveRunsForCompany.mockReset();
  sidebarBadgesApiMock.get.mockReset();
  heartbeatsApiMock.liveRunsForCompany.mockResolvedValue([]);
  sidebarBadgesApiMock.get.mockResolvedValue({
    inbox: 0,
    blockers: 7,
    approvals: 3,
    failedRuns: 2,
    joinRequests: 1,
    taskDates: {
      today: 2,
      tomorrow: 1,
      next7Days: 8,
    },
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("Sidebar blocker badges", () => {
  it("shows the danger badge on Blockers and leaves Inbox unbadged", async () => {
    await renderSidebar();

    await waitForAssertion(() => {
      expect(sidebarBadgesApiMock.get).toHaveBeenCalledWith("company-1", {
        today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
      expect(linkByHref("/blockers")?.textContent).toContain("7");
    });

    const inboxLink = linkByHref("/inbox");
    const blockersLink = linkByHref("/blockers");

    expect(inboxLink).not.toBeNull();
    expect(blockersLink).not.toBeNull();
    expect(inboxLink?.textContent).toBe("Inbox");
    expect(blockersLink?.textContent).toContain("Blockers");

    const blockerBadge = Array.from(blockersLink!.querySelectorAll("span")).find(
      (element) => element.textContent === "7",
    );
    expect(blockerBadge).not.toBeUndefined();
    expect(blockerBadge?.className).toContain("bg-red-600/90");
  });

  it("exposes a saved My Tasks board", async () => {
    await renderSidebar();

    await waitForAssertion(() => {
      expect(linkByHref("/my-issues")?.textContent).toBe("My Tasks");
    });
  });

  it("shows TickTick-style task date shortcuts with counts", async () => {
    await renderSidebar();

    await waitForAssertion(() => {
      expect(linkByHref("/tasks/today")?.textContent).toContain("Today");
      expect(linkByHref("/tasks/today")?.textContent).toContain("2");
      expect(linkByHref("/tasks/tomorrow")?.textContent).toContain("Tomorrow");
      expect(linkByHref("/tasks/tomorrow")?.textContent).toContain("1");
      expect(linkByHref("/tasks/next-7-days")?.textContent).toContain("Next 7 Days");
      expect(linkByHref("/tasks/next-7-days")?.textContent).toContain("8");
      expect(linkByHref("/tasks/calendar")?.textContent).toBe("Calendar");
    });
  });
});
