// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "@/components/BreadcrumbBar";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { AuditHub } from "./AuditHub";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to }: { children: ReactNode; className?: string; to: string }) => (
    <a className={className} href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    collapsed: false,
    isMobile: false,
    toggleCollapsed: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { issuePrefix: "TES" } }),
}));

vi.mock("@/context/PanelContext", () => ({
  usePanel: () => ({ panelVisible: true, togglePanelVisible: vi.fn() }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotOutlet: () => null,
}));

vi.mock("@/plugins/launchers", () => ({
  usePluginLaunchers: () => ({ launchers: [] }),
  PluginLauncherOutlet: () => null,
}));

vi.mock("./AuditFeed", () => ({ AuditFeed: () => null }));
vi.mock("./AuditRuns", () => ({ AuditRuns: () => null }));
vi.mock("./RoutineAuditActivity", () => ({ RoutineAuditActivity: () => null }));
vi.mock("@/pages/Costs", () => ({ Costs: () => null }));
vi.mock("@/pages/Timeline", () => ({ Timeline: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AuditHub page headings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(section: "activity" | "runs" | "costs" | "budgets" | "timeline") {
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <BreadcrumbBar />
          <main>
            <AuditHub section={section} />
          </main>
        </BreadcrumbProvider>,
      );
    });
  }

  it("uses the breadcrumb bar as the only h1 on the Activity section", async () => {
    await render("activity");

    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0].closest("main")).toBeNull();
    expect(headings[0].textContent).toBe("Audit");
    expect(container.querySelector("main h2")?.textContent).toBe("Audit");
  });

  it.each(["runs", "costs", "budgets", "timeline"] as const)(
    "keeps the page heading as the only h1 on the %s section",
    async (section) => {
      await render(section);

      const headings = container.querySelectorAll("h1");
      expect(headings).toHaveLength(1);
      expect(headings[0].closest("main")).not.toBeNull();
      expect(headings[0].textContent).toBe("Audit");
    },
  );
});
