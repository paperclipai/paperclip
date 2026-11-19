// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";
import { TooltipProvider } from "@/components/ui/tooltip";

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: () => {},
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, ...props }: {
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    to: string;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => {
    const resolvedClassName = typeof className === "function" ? className({ isActive: false }) : className;
    const resolvedChildren = typeof children === "function" ? children({ isActive: false }) : children;
    return (
      <a href={to} className={resolvedClassName} {...props}>
        {resolvedChildren}
      </a>
    );
  },
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarNavItem", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  function render(node: ReactNode) {
    act(() => {
      root.render(<TooltipProvider>{node}</TooltipProvider>);
    });
  }

  function link() {
    return container.querySelector("a") as HTMLAnchorElement;
  }

  function classTokens(element: Element | null | undefined) {
    return element?.className.toString().split(/\s+/).filter(Boolean) ?? [];
  }

  it("shows the full label and numeric badge when expanded", () => {
    render(<SidebarNavItem to="/inbox" label="Inbox" icon={Inbox} badge={28} badgeLabel="unread" />);

    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Inbox");
    expect(label?.className).not.toContain("sr-only");
    // The numeric badge is rendered in full (not a dot) and no rail aria-label is set.
    expect(container.textContent).toContain("28");
    expect(link().getAttribute("aria-label")).toBeNull();
  });

  it("outlines icon alert badges with the streamlined sidebar surface", () => {
    render(<SidebarNavItem to="/inbox" label="Inbox" icon={Inbox} alert />);

    const alertBadge = container.querySelector('[data-slot="sidebar-icon-alert-badge"]');
    expect(alertBadge).not.toBeNull();
    expect(classTokens(alertBadge)).toContain("shadow-(--shadow-sidebar-icon-badge)");
    expect(classTokens(alertBadge)).not.toContain("shadow-(--shadow-extract-12)");
  });

  it("omits the icon slot when an item has no icon", () => {
    render(<SidebarNavItem to="/issues/one" label="Recent task" />);

    expect(link().querySelector('[data-slot="sidebar-nav-icon"]')).toBeNull();
    expect(link().firstElementChild?.textContent).toBe("Recent task");
  });

  it("uses the sidebar accent surface for the active item", () => {
    render(<SidebarNavItem to="/issues" label="Tasks" icon={Inbox} active />);

    expect(classTokens(link())).toContain("bg-sidebar-accent");
    expect(classTokens(link())).toContain("text-sidebar-accent-foreground");
    expect(classTokens(link())).not.toContain("bg-background");
  });

  it("uses the legible sidebar accent surface for hover", () => {
    render(<SidebarNavItem to="/issues" label="Tasks" icon={Inbox} />);

    expect(classTokens(link())).toContain("hover:bg-sidebar-accent");
    expect(classTokens(link())).toContain("hover:text-sidebar-accent-foreground");
    expect(classTokens(link())).not.toContain("hover:bg-background");
  });

});
