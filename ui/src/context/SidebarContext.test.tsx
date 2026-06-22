// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, useSidebar } from "./SidebarContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";

// Mutable media state driving the matchMedia mock.
const mediaState = { mobile: false, hoverFine: true };

function setViewport({ mobile, hoverFine }: { mobile?: boolean; hoverFine?: boolean }) {
  if (typeof mobile === "boolean") mediaState.mobile = mobile;
  if (typeof hoverFine === "boolean") mediaState.hoverFine = hoverFine;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: mediaState.mobile ? 500 : 1280,
  });
}

let capturedValue: ReturnType<typeof useSidebar> | null = null;

function Capture() {
  capturedValue = useSidebar();
  return null;
}

function renderProvider(): { root: Root; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <SidebarProvider>
        <Capture />
      </SidebarProvider>,
    );
  });
  return { root, host };
}

describe("SidebarContext", () => {
  let active: { root: Root; host: HTMLDivElement } | null = null;

  beforeEach(() => {
    localStorage.clear();
    capturedValue = null;
    setViewport({ mobile: false, hoverFine: true });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => {
        const isHoverQuery = query.includes("(hover: hover)");
        const matches = isHoverQuery ? mediaState.hoverFine : mediaState.mobile;
        return {
          matches,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      }),
    });
  });

  afterEach(() => {
    if (active) {
      act(() => active!.root.unmount());
      active.host.remove();
      active = null;
    }
    localStorage.clear();
  });

  describe("precedence: user pin > route request > default", () => {
    it("defaults to expanded (collapsed=false) with no pin and no route request", () => {
      active = renderProvider();
      expect(capturedValue?.collapsed).toBe(false);
    });

    it("uses the route request when there is no user pin", () => {
      active = renderProvider();
      act(() => capturedValue?.setRouteRequestsCollapsed(true));
      expect(capturedValue?.collapsed).toBe(true);
    });

    it("lets an explicit user pin override the route request", () => {
      active = renderProvider();
      act(() => capturedValue?.setRouteRequestsCollapsed(true));
      expect(capturedValue?.collapsed).toBe(true);

      // User pins expanded — this must win over the route's collapse request.
      act(() => capturedValue?.setCollapsed(false));
      expect(capturedValue?.collapsed).toBe(false);

      // And pinning collapsed wins too.
      act(() => capturedValue?.setCollapsed(true));
      expect(capturedValue?.collapsed).toBe(true);
    });

    it("toggleCollapsed flips the effective mode and records a pin", () => {
      active = renderProvider();
      expect(capturedValue?.collapsed).toBe(false);

      act(() => capturedValue?.toggleCollapsed());
      expect(capturedValue?.collapsed).toBe(true);
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("1");

      act(() => capturedValue?.toggleCollapsed());
      expect(capturedValue?.collapsed).toBe(false);
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("0");
    });

    it("toggleCollapsed pins expanded when only a route request is active", () => {
      active = renderProvider();
      act(() => capturedValue?.setRouteRequestsCollapsed(true));
      expect(capturedValue?.collapsed).toBe(true);

      // Effective is collapsed (via route); toggling should flip to expanded.
      act(() => capturedValue?.toggleCollapsed());
      expect(capturedValue?.collapsed).toBe(false);
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("0");
    });
  });

  describe("forced collapse (secondary sidebar): overrides the pin, preserves preference", () => {
    it("forces collapsed even when the user pinned expanded, without mutating the pin", () => {
      active = renderProvider();
      // User prefers expanded site-wide.
      act(() => capturedValue?.setCollapsed(false));
      expect(capturedValue?.collapsed).toBe(false);
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("0");

      // Entering a secondary-sidebar route forces the rail and locks it.
      act(() => capturedValue?.setForceCollapsed(true));
      expect(capturedValue?.collapsed).toBe(true);
      expect(capturedValue?.collapseLocked).toBe(true);
      // The persisted preference is untouched.
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("0");
    });

    it("restores the user's preference when the force is cleared (leaving the route)", () => {
      active = renderProvider();
      act(() => capturedValue?.setCollapsed(false));
      act(() => capturedValue?.setForceCollapsed(true));
      expect(capturedValue?.collapsed).toBe(true);

      // Navigating away clears the force; the expanded preference returns.
      act(() => capturedValue?.setForceCollapsed(false));
      expect(capturedValue?.collapsed).toBe(false);
      expect(capturedValue?.collapseLocked).toBe(false);
    });

    it("locks the toggle while forced: toggleCollapsed is a no-op and never writes the pin", () => {
      active = renderProvider();
      act(() => capturedValue?.setCollapsed(false));
      act(() => capturedValue?.setForceCollapsed(true));

      act(() => capturedValue?.toggleCollapsed());
      expect(capturedValue?.collapsed).toBe(true); // still forced
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("0"); // pin unchanged
    });

    it("never forces or locks on mobile", () => {
      setViewport({ mobile: true });
      active = renderProvider();
      act(() => capturedValue?.setForceCollapsed(true));
      expect(capturedValue?.collapsed).toBe(false);
      expect(capturedValue?.collapseLocked).toBe(false);
    });
  });

  describe("persistence round-trip", () => {
    it("writes '1'/'0' to localStorage on setCollapsed", () => {
      active = renderProvider();
      act(() => capturedValue?.setCollapsed(true));
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("1");
      act(() => capturedValue?.setCollapsed(false));
      expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("0");
    });

    it("reads the persisted pin synchronously on first paint (no flash)", () => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
      active = renderProvider();
      // Collapsed is already true on the very first captured render.
      expect(capturedValue?.collapsed).toBe(true);
    });

    it("treats a missing/garbage value as unpinned", () => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, "yes");
      active = renderProvider();
      expect(capturedValue?.collapsed).toBe(false);
      // Unpinned, so a route request still applies.
      act(() => capturedValue?.setRouteRequestsCollapsed(true));
      expect(capturedValue?.collapsed).toBe(true);
    });
  });

  describe("mobile gating", () => {
    it("never reports collapsed on mobile even with a collapsed pin", () => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
      setViewport({ mobile: true });
      active = renderProvider();
      expect(capturedValue?.isMobile).toBe(true);
      expect(capturedValue?.collapsed).toBe(false);
    });

    it("never reports peeking on mobile", () => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
      setViewport({ mobile: true });
      active = renderProvider();
      act(() => capturedValue?.setPeeking(true));
      expect(capturedValue?.peeking).toBe(false);
    });
  });

  describe("peek gating", () => {
    it("peeks when collapsed on a hover-capable pointer", () => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
      setViewport({ mobile: false, hoverFine: true });
      active = renderProvider();
      expect(capturedValue?.collapsed).toBe(true);
      act(() => capturedValue?.setPeeking(true));
      expect(capturedValue?.peeking).toBe(true);
    });

    it("does not peek when expanded", () => {
      setViewport({ mobile: false, hoverFine: true });
      active = renderProvider();
      expect(capturedValue?.collapsed).toBe(false);
      act(() => capturedValue?.setPeeking(true));
      expect(capturedValue?.peeking).toBe(false);
    });

    it("does not peek on a coarse/non-hover pointer", () => {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
      setViewport({ mobile: false, hoverFine: false });
      active = renderProvider();
      expect(capturedValue?.collapsed).toBe(true);
      act(() => capturedValue?.setPeeking(true));
      expect(capturedValue?.peeking).toBe(false);
    });
  });

  describe("back-compat", () => {
    it("retains sidebarOpen/toggleSidebar for the drawer", () => {
      active = renderProvider();
      const initial = capturedValue?.sidebarOpen;
      expect(typeof initial).toBe("boolean");
      act(() => capturedValue?.toggleSidebar());
      expect(capturedValue?.sidebarOpen).toBe(!initial);
    });
  });
});
