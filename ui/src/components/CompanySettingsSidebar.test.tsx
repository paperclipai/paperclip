// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockSidebarBadgesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

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

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanySettingsSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubEnv("VITE_PAPERCLIP_EXPERIMENTAL_MODE", "true");
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSidebarBadgesApi.get.mockResolvedValue({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 2,
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "admin@paperclip.local", name: "Admin", image: null },
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      memberships: [],
      source: "session",
      keyId: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllEnvs();
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
    expect(container.textContent).toContain("Experimental");
    expect(container.textContent).toContain("Environments");
    expect(container.textContent).toContain("Access");
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
        to: "/company/settings/experimental-features",
        label: "Experimental",
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
        to: "/company/settings/access",
        label: "Access",
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

  it("hides the experimental section when experimental mode is disabled", async () => {
    vi.stubEnv("VITE_PAPERCLIP_EXPERIMENTAL_MODE", "false");
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

    expect(container.textContent).not.toContain("Experimental");
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/experimental-features",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the experimental section for non-admin users", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "member@paperclip.local", name: "Member", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      source: "session",
      keyId: null,
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

    expect(container.textContent).not.toContain("Experimental");
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/experimental-features",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
