// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConnectionSidebar } from "./AppConnectionSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const currentPath = vi.hoisted(() => ({ value: "/apps/conn-1/permissions" }));
const mockToolsApi = vi.hoisted(() => ({
  getConnection: vi.fn(),
  listGallery: vi.fn(),
  listAppsAttention: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    onClick,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    onClick?: () => void;
    className?: string;
  }) => (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("@/api/tools", () => ({
  toolsApi: mockToolsApi,
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: (props: {
    to: string;
    label: string;
    end?: boolean;
    badge?: number;
    badgeTone?: string;
    badgeLabel?: string;
  }) => {
    sidebarNavItemMock(props);
    return (
      <div data-to={props.to} data-active={props.to === currentPath.value ? "true" : "false"}>
        {props.label}
        {props.badge ? ` ${props.badge}` : ""}
      </div>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    name: "GitHub",
    transport: "remote_http",
    status: "active",
    healthStatus: "healthy",
    enabled: true,
    config: {},
    transportConfig: {},
    ...overrides,
  };
}

describe("AppConnectionSidebar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPath.value = "/apps/conn-1/permissions";
    mockToolsApi.getConnection.mockResolvedValue(connection());
    mockToolsApi.listGallery.mockResolvedValue({
      apps: [{ key: "github", name: "GitHub", logoUrl: "https://example.test/github.png" }],
    });
    mockToolsApi.listAppsAttention.mockResolvedValue({
      apps: [
        {
          connection: connection(),
          pendingActionRequestCount: 2,
          quarantinedCatalogEntryCount: 3,
          healthNeedsAttention: false,
          reasons: ["pending_action_requests", "quarantined_catalog_entries"],
        },
      ],
      totals: {},
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderSidebar() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AppConnectionSidebar connectionId="conn-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders a back link and five app tabs", async () => {
    await renderSidebar();

    expect(container.querySelector('a[href="/apps"]')?.textContent).toContain("All apps");
    expect(container.textContent).toContain("GitHub");
    expect(container.querySelectorAll("[data-to]").length).toBe(5);
    expect(sidebarNavItemMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/apps/conn-1/setup", label: "Setup", end: true }));
    expect(sidebarNavItemMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/apps/conn-1/review", label: "Review", badge: 5, badgeTone: "danger" }));
    expect(sidebarNavItemMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/apps/conn-1/permissions", label: "Permissions", end: true }));
    expect(sidebarNavItemMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/apps/conn-1/activity", label: "Activity", end: true }));
    expect(sidebarNavItemMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/apps/conn-1/advanced", label: "Advanced", end: true }));
  });

  it("marks the current tab active through the nav item target", async () => {
    await renderSidebar();

    expect(container.querySelector('[data-to="/apps/conn-1/permissions"]')?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector('[data-to="/apps/conn-1/setup"]')?.getAttribute("data-active")).toBe("false");
  });
});
