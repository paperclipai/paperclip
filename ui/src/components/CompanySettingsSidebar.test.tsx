// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockSidebarBadgesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
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
  NavLink: ({
    children,
    to,
  }: {
    children: React.ReactNode;
    to: string;
  }) => <a href={to}>{children}</a>,
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

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
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
    mockPluginsApi.list.mockResolvedValue([]);
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders one unified settings list without company or instance headers", async () => {
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
    expect(container.textContent).not.toContain("Company Settings");
    expect(container.textContent).not.toContain("Instance Settings");
    expect(container.textContent).toContain("General");
    expect(container.textContent).toContain("Environments");
    expect(container.textContent).toContain("Export");
    expect(container.textContent).toContain("Import");
    expect(container.textContent).toContain("Members");
    expect(container.textContent).toContain("Invites");
    expect(container.textContent).toContain("Secrets");
    expect(container.textContent).toContain("Access");
    expect(container.textContent).toContain("Heartbeats");
    expect(container.textContent).not.toContain("Tools & Access");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings",
        label: "General",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/export",
        label: "Export",
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/import",
        label: "Import",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/environments",
        label: "Environments",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/access",
        label: "Access",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/heartbeats",
        label: "Heartbeats",
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
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/profile",
        label: "Profile",
        end: true,
      }),
    );
    expect(new Set(
      sidebarNavItemMock.mock.calls
        .filter(([props]) => props.label === "General")
        .map(([props]) => props.to),
    )).toEqual(new Set(["/company/settings"]));
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/plugins",
        label: "Plugins",
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/adapters",
        label: "Adapters",
      }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/tools",
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

  it("renders instance plugin links while filtering sandbox-provider-only plugins", async () => {
    mockPluginsApi.list.mockResolvedValue([
      {
        id: "linear",
        packageName: "@example/linear",
        manifestJson: {
          displayName: "Linear",
          environmentDrivers: [],
        },
      },
      {
        id: "sandbox-only",
        packageName: "@example/sandbox",
        manifestJson: {
          displayName: "Sandbox only",
          environmentDrivers: [{ kind: "sandbox_provider", driverKey: "e2b" }],
        },
      },
      {
        id: "hybrid",
        packageName: "@example/hybrid",
        manifestJson: {
          displayName: "Hybrid",
          environmentDrivers: [
            { kind: "sandbox_provider", driverKey: "e2b" },
            { kind: "environment_driver", driverKey: "ssh" },
          ],
        },
      },
    ]);
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

    const pluginLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href^="/company/settings/instance/plugins/"]'),
    );
    expect(pluginLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/company/settings/instance/plugins/linear",
      "/company/settings/instance/plugins/hybrid",
    ]);
    expect(container.textContent).toContain("Linear");
    expect(container.textContent).toContain("Hybrid");
    expect(container.textContent).not.toContain("Sandbox only");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("CompanySettingsSidebar operator-hidden entries", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSidebarBadgesApi.get.mockResolvedValue({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
    });
    mockPluginsApi.list.mockResolvedValue([]);
    mockUsePluginSlots.mockReturnValue({ slots: [], isLoading: false, errorMessage: null });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderSidebar(hiddenSettings?: string[], cloud?: { managed: boolean }) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      ...(hiddenSettings ? { hiddenSettings } : {}),
      ...(cloud ? { cloud } : {}),
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("skips operator-hidden pages and their queries", async () => {
    await renderSidebar(["instance.plugins", "instance.heartbeats"]);

    expect(container.textContent).not.toContain("Plugins");
    expect(container.textContent).not.toContain("Heartbeats");
    expect(container.textContent).toContain("General");
    expect(container.textContent).toContain("Adapters");
    expect(container.textContent).toContain("Access");
    expect(mockPluginsApi.list).not.toHaveBeenCalled();
  });

  it("keeps every entry when nothing is hidden", async () => {
    await renderSidebar();

    expect(container.textContent).toContain("Access");
    expect(container.textContent).toContain("Plugins");
    expect(container.textContent).toContain("Heartbeats");
    expect(container.textContent).toContain("Adapters");
    expect(container.textContent).toContain("Import");
    expect(mockPluginsApi.list).toHaveBeenCalled();
  });

  it("hides Import but keeps Export on a Cloud-managed instance", async () => {
    await renderSidebar(undefined, { managed: true });

    expect(container.textContent).not.toContain("Import");
    expect(container.textContent).toContain("Export");
  });

  it("hides operator-hidden company pages", async () => {
    await renderSidebar([
      "company.members",
      "company.invites",
      "company.secrets",
      "company.export",
      "company.import",
    ]);

    expect(container.textContent).toContain("General");
    expect(container.textContent).not.toContain("Members");
    expect(container.textContent).not.toContain("Invites");
    expect(container.textContent).not.toContain("Secrets");
    expect(container.textContent).not.toContain("Export");
    expect(container.textContent).not.toContain("Import");
  });
});
