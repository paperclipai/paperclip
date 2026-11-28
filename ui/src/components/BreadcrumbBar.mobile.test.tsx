// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { BreadcrumbProvider, useBreadcrumbs, type Breadcrumb, type BreadcrumbPanelControl } from "../context/BreadcrumbContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  isMobile: true,
  toggleSidebar: vi.fn(),
  panelVisible: false,
  togglePanelVisible: vi.fn(),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: mockState.isMobile,
    toggleSidebar: mockState.toggleSidebar,
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    panelVisible: mockState.panelVisible,
    togglePanelVisible: mockState.togglePanelVisible,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP" },
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

vi.mock("./coordinator/CoordinatorPresentation", () => ({
  useCoordinatorPresentation: () => false,
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    Link: ({ to, children, ...props }: { to: string; children: ReactNode } & React.ComponentProps<"a">) => (
      <a href={to} {...props}>{children}</a>
    ),
    useLocation: actual.useLocation,
  };
});

function SeedBreadcrumbs({
  crumbs,
  panelControl = null,
}: {
  crumbs: Breadcrumb[];
  panelControl?: BreadcrumbPanelControl | null;
}) {
  const { setBreadcrumbs, setBreadcrumbPanelControl } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs(crumbs);
    setBreadcrumbPanelControl(panelControl);
  }, [crumbs, panelControl, setBreadcrumbs, setBreadcrumbPanelControl]);
  return null;
}

describe("BreadcrumbBar mobile behavior", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockState.isMobile = true;
    mockState.panelVisible = false;
    mockState.toggleSidebar.mockReset();
    mockState.togglePanelVisible.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the properties toggle on a single-crumb mobile task trail when panel control is registered", () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        <MemoryRouter>
          <BreadcrumbProvider>
            <SeedBreadcrumbs
              crumbs={[
                { label: "Tasks", href: "/issues" },
                { label: "Fix mobile properties panel", identifier: "PAP-6794" },
              ]}
              panelControl={{ open: false, onToggle }}
            />
            <BreadcrumbBar showPropertiesToggle={false} />
          </BreadcrumbProvider>
        </MemoryRouter>,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show properties"]');
    expect(toggle).not.toBeNull();
    act(() => {
      toggle!.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders the properties toggle on a multi-crumb mobile subtask trail and shrinks ancestor before current crumb", () => {
    const onToggle = vi.fn();
    act(() => {
      root.render(
        <MemoryRouter>
          <BreadcrumbProvider>
            <SeedBreadcrumbs
              crumbs={[
                { label: "Tasks", href: "/issues" },
                { label: "Find and stabilize every mobile layout bug", href: "/issues/PAP-6700" },
                { label: "Display status and properties cleanly", identifier: "PAP-6794" },
              ]}
              panelControl={{ open: true, onToggle }}
            />
            <BreadcrumbBar showPropertiesToggle={false} />
          </BreadcrumbProvider>
        </MemoryRouter>,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Hide properties"]');
    expect(toggle).not.toBeNull();
    act(() => {
      toggle!.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);

    const items = [...container.querySelectorAll<HTMLLIElement>('[data-slot="breadcrumb-item"]')];
    expect(items).toHaveLength(2);
    expect(items[0]!.className).toContain("max-w-24");
    expect(items[0]!.className).toContain("shrink");
    expect(items[0]!.className).not.toContain("shrink-0");
    expect(items[1]!.className).toContain("flex-1");
    expect(items[1]!.className).toContain("min-w-0");
  });

  it("collapses leading root segments on mobile 3-segment trails so the current page label keeps width", () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <BreadcrumbProvider>
            <SeedBreadcrumbs
              crumbs={[
                { label: "Agents", href: "/agents/all" },
                { label: "Antigravity", href: "/agents/antigravity/overview" },
                { label: "Identity" },
              ]}
            />
            <BreadcrumbBar />
          </BreadcrumbProvider>
        </MemoryRouter>,
      );
    });

    const items = [...container.querySelectorAll<HTMLLIElement>('[data-slot="breadcrumb-item"]')];
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe("Antigravity");
    expect(items[0]!.className).toContain("max-w-28");
    expect(items[0]!.className).not.toContain("shrink-0");
    expect(items[1]!.textContent).toBe("Identity");
    expect(items[1]!.className).toContain("flex-1");
    expect(items[1]!.className).toContain("min-w-0");
  });
});
