// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.production";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
    state?: unknown;
    end?: boolean;
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" } }),
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn(), collapsed: false, peeking: false }),
}));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/attention", () => ({ attentionApi: { list: vi.fn().mockResolvedValue({ items: [] }) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }) }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
vi.mock("./SidebarCompanyMenu.production", () => ({ SidebarCompanyMenu: () => <div>Company menu</div> }));
vi.mock("./SidebarAgents.production", () => ({ SidebarAgents: () => null }));
vi.mock("./SidebarProjects", () => ({ SidebarProjects: () => null }));
vi.mock("./SidebarStarredProjects.production", () => ({ SidebarStarredProjects: () => null }));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("production Sidebar ordering", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderSidebar() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sidebar />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  const labels = (group: Element | null | undefined) =>
    [...(group?.querySelectorAll("a") ?? [])].map((anchor) => anchor.textContent?.trim());
  const primaryGroup = () => container.querySelector("nav > div");
  const workSection = () =>
    [...container.querySelectorAll("nav > div")].find((section) => section.textContent?.startsWith("Work"));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps Dashboard and Inbox on top and Tasks in Work while Responsibilities is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableResponsibilities: false });
    await renderSidebar();

    expect(labels(primaryGroup())).toEqual(["Search", "Dashboard", "Inbox"]);
    expect(labels(workSection())[0]).toBe("Tasks");
    expect(container.querySelector('a[href="/responsibilities"]')).toBeNull();
  });

  it("leads with the new dashboard, then Tasks and Inbox, and leaves the classic dashboard out", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableResponsibilities: true });
    await renderSidebar();

    expect(labels(primaryGroup())).toEqual(["Search", "Dashboard", "Tasks", "Inbox"]);
    expect(container.querySelector('a[href="/responsibilities"]')?.textContent).toContain("Dashboard");
    expect(container.querySelectorAll('a[href="/issues"]')).toHaveLength(1);
    expect(container.querySelector('a[href="/dashboard"]')).toBeNull();
    // This shell has no Chat row; none is invented.
    expect(container.querySelector('a[href="/chats"]')).toBeNull();
  });
});
