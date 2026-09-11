// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsContextualSidebar } from "./SkillsContextualSidebar";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({ pathname: "/PAP/skills", search: "" }));

vi.mock("@/lib/router", () => ({
  useLocation: () => mockLocation,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { name: "Paperclip", issuePrefix: "PAP" } }),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));
vi.mock("./SidebarNavItem", () => ({
  SidebarNavExpandedProvider: ({ children }: { children: React.ReactNode }) => children,
  SidebarNavItem: (props: { to: string; label: string; active?: boolean }) => {
    sidebarNavItemMock(props);
    return <a href={props.to} aria-current={props.active ? "page" : undefined}>{props.label}</a>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SkillsContextualSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockLocation.pathname = "/PAP/skills";
    mockLocation.search = "";
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    const root = createRoot(container);
    act(() => root.render(<SkillsContextualSidebar />));
    return root;
  }

  it("keeps Installed, Discover, and authored My Skills visible together", () => {
    const root = render();

    expect(container.textContent).toContain("Installed");
    expect(container.textContent).toContain("Discover");
    expect(container.textContent).toContain("My Skills");
    expect(container.textContent).toContain("Skills you create, edit, and test.");
    expect(container.textContent).not.toContain("Paperclip");
    expect(container.querySelector('[aria-label="Back from Skills"]')).toBeNull();
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Installed");

    act(() => root.unmount());
  });

  it("uses the shared contextual-navigation spacing and type contract", () => {
    const root = render();

    expect(container.querySelector('[data-slot="contextual-sidebar-nav"]')?.className).toBe(
      contextualSidebarStyles.nav,
    );
    expect(container.querySelector('[data-slot="contextual-sidebar-section"]')?.className).toBe(
      contextualSidebarStyles.section,
    );
    expect(container.querySelector('[data-slot="contextual-sidebar-section-label"]')?.className).toBe(
      contextualSidebarStyles.sectionLabel,
    );
    expect(container.querySelector('[data-slot="contextual-sidebar-section-description"]')?.className).toBe(
      contextualSidebarStyles.sectionDescription,
    );
    expect(
      Array.from(container.querySelectorAll('[data-slot="contextual-sidebar-group"]')).every(
        (group) => group.className === contextualSidebarStyles.group,
      ),
    ).toBe(true);

    act(() => root.unmount());
  });

  it("activates Discover for old catalog links without changing the navigation", () => {
    mockLocation.search = "?tab=bundled";
    const root = render();

    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Discover");
    expect(sidebarNavItemMock.mock.calls.map(([props]) => props.to)).toEqual([
      "/skills",
      "/skills?tab=discover",
      "/skills/studio",
    ]);

    act(() => root.unmount());
  });

  it("activates My Skills throughout Studio", () => {
    mockLocation.pathname = "/PAP/skills/studio/skill-1";
    mockLocation.search = "?tab=files";
    const root = render();

    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("My Skills");

    act(() => root.unmount());
  });
});
