// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsSidebar } from "./AppsSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockToolsApi = vi.hoisted(() => ({
  listActionRequests: vi.fn(),
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
    selectedCompany: { id: "company-1", name: "Paperclip" },
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
    liveCount?: number;
    badge?: number;
  }) => {
    sidebarNavItemMock(props);
    return <div data-to={props.to}>{props.label}</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// React 19 does not export a usable `act` in this vitest/jsdom setup; use a
// flushSync-based helper (PAP-12371 gotcha).
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("AppsSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockToolsApi.listActionRequests.mockResolvedValue({ actionRequests: [] });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the consolidated connector and review doors without retired developer links", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AppsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Apps");
    expect(container.textContent).not.toContain("Developer");
    expect(container.textContent).not.toContain("Advanced setup for developers");
    expect(container.textContent).not.toContain("Most teams");
    expect(container.textContent).not.toMatch(/you (?:won'?t|will not) need this/i);
    // Paste-config discovery now lives inside the custom connector row;
    // assert both advanced setup items remain absent at the item level below.

    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/apps", label: "Connectors", end: true }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/apps/review", label: "Review" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: "Connections" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: "Needs attention" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: "Run your own" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: "Paste a config" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: "Applications" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "/apps/advanced/gateways", label: "Gateways" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "/apps/advanced/profiles", label: "Profiles" }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(expect.objectContaining({ label: "Rules" }));
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(expect.objectContaining({ label: "Health" }));
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "/apps/advanced/audit" }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
