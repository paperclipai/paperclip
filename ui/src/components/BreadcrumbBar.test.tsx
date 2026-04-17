// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";

const mockUseBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockUseBreadcrumbs(),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    toggleSidebar: vi.fn(),
    isMobile: false,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: null,
    selectedCompany: null,
  }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotOutlet: () => null,
}));

vi.mock("@/plugins/launchers", () => ({
  usePluginLaunchers: () => ({ launchers: [] }),
  PluginLauncherOutlet: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span data-testid="crumb-status-icon">{status}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BreadcrumbBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders status icon and ticket id for the current issue breadcrumb", () => {
    mockUseBreadcrumbs.mockReturnValue({
      breadcrumbs: [
        { label: "Inbox", href: "/inbox" },
        { label: "GST-56: Execute CEO directive", status: "blocked" },
      ],
      mobileToolbar: null,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<BreadcrumbBar />);
    });

    expect(container.textContent).toContain("GST-56: Execute CEO directive");
    const statusIcon = container.querySelector('[data-testid="crumb-status-icon"]');
    expect(statusIcon?.textContent).toBe("blocked");

    act(() => root.unmount());
  });
});
