// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockSidebarBadgesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockUsePluginSlots = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    onClick?: () => void;
  }) => (
    <button type="button" data-to={to} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: (props: {
    to: string;
    label: string;
    end?: boolean;
    badge?: number;
  }) => {
    sidebarNavItemMock(props);
    return <div>{props.label}</div>;
  },
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Workspace switcher</div>,
}));

vi.mock("@/api/sidebarBadges", () => ({
  sidebarBadgesApi: mockSidebarBadgesApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("CompanySettingsSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSidebarBadgesApi.get.mockResolvedValue({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 2,
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: false,
    });
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: false,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the company back link and the settings sections in the sidebar", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("Company Settings");
    expect(container.textContent).toContain("General");
    expect(container.textContent).toContain("Environments");
    expect(container.textContent).not.toContain("Cloud upstream");
    expect(container.textContent).toContain("Members");
    expect(container.textContent).not.toContain("Cloud upstream");
    expect(container.textContent).toContain("Invites");
    expect(container.textContent).toContain("Secrets");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings",
        label: "General",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/environments",
        label: "Environments",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/members",
        label: "Members",
        badge: 2,
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/invites",
        label: "Invites",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/secrets",
        label: "Secrets",
        end: true,
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows cloud upstream only when cloud sync is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: true,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Cloud upstream");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/cloud-upstream",
        label: "Cloud upstream",
        end: true,
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders company settings pages contributed by ready plugins", async () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "permissions",
          displayName: "Permissions",
          exportName: "PermissionsPage",
          routePath: "permissions",
          pluginId: "plugin-1",
          pluginKey: "permissions-extension",
          pluginDisplayName: "Permissions Extension",
          pluginVersion: "0.1.0",
        },
      ],
      isLoading: false,
      errorMessage: null,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Permissions");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/permissions",
        label: "Permissions",
        end: true,
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows cloud upstream only when cloud sync is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: true,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Cloud upstream");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/cloud-upstream",
        label: "Cloud upstream",
        end: true,
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
