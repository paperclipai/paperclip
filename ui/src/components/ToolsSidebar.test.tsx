// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolsSidebar } from "./ToolsSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockToolsApi = vi.hoisted(() => ({
  listRuntimeSlots: vi.fn(),
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
  }) => {
    sidebarNavItemMock(props);
    return <div data-to={props.to}>{props.label}</div>;
  },
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

describe("ToolsSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockToolsApi.listRuntimeSlots.mockResolvedValue({
      runtimeSlots: [
        { id: "slot-1", status: "running" },
        { id: "slot-2", status: "stopped" },
      ],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the tools sections as secondary-sidebar nav items", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToolsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("Tools");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/tools", label: "Overview", end: true }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/tools/applications", label: "Applications", end: true }),
    );
    expect(sidebarNavItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "/tools/connections", label: "Connections", end: true }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/tools/runtime", label: "Runtime", end: true, liveCount: 1 }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
