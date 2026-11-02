// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, useSidebar } from "../context/SidebarContext";
import { RequestCollapsedSidebar } from "./RequestCollapsedSidebar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedValue: ReturnType<typeof useSidebar> | null = null;

function Capture() {
  capturedValue = useSidebar();
  return null;
}

// A tiny stand-in for "a route that brings its own sidebar". When `onRoute`
// is true it mounts <RequestCollapsedSidebar/>; flipping it to false models
// navigating away to a route that does not request a collapse.
function Harness({ onRoute }: { onRoute: boolean }) {
  return (
    <SidebarProvider>
      <Capture />
      {onRoute ? <RequestCollapsedSidebar /> : null}
    </SidebarProvider>
  );
}

async function render(onRoute: boolean): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness onRoute={onRoute} />));
  return { root, host };
}

describe("RequestCollapsedSidebar", () => {
  let active: { root: Root; host: HTMLDivElement } | null = null;

  beforeEach(() => {
    localStorage.clear();
    capturedValue = null;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1280, // desktop: collapsed/peek are meaningful
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        // Desktop, hover-capable pointer.
        matches: query.includes("(hover: hover)"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(async () => {
    if (active) {
      await act(async () => active!.root.unmount());
      active.host.remove();
      active = null;
    }
    localStorage.clear();
  });

  it("records the legacy route request without collapsing the global navigation", async () => {
    active = await render(true);
    expect(capturedValue?.routeRequestsCollapsed).toBe(true);
    expect(capturedValue?.collapsed).toBe(false);
  });

  it("keeps the global navigation expanded when old pin APIs are called", async () => {
    active = await render(true);
    expect(capturedValue?.collapsed).toBe(false);

    flushSync(() => capturedValue?.setCollapsed(true));
    expect(capturedValue?.routeRequestsCollapsed).toBe(true);
    expect(capturedValue?.collapsed).toBe(false);
  });

  it("clears the request on unmount, restoring the global default", async () => {
    active = await render(true);
    expect(capturedValue?.collapsed).toBe(false);

    // Navigate away: the route (and its <RequestCollapsedSidebar/>) unmounts.
    await act(async () => active!.root.render(<Harness onRoute={false} />));
    expect(capturedValue?.routeRequestsCollapsed).toBe(false);
    expect(capturedValue?.collapsed).toBe(false);
  });

  it("clears the request without persisting a retired collapsed pin", async () => {
    active = await render(true);
    flushSync(() => capturedValue?.setCollapsed(true));
    expect(localStorage.getItem("paperclip.sidebar.collapsed")).toBeNull();

    await act(async () => active!.root.render(<Harness onRoute={false} />));
    expect(capturedValue?.routeRequestsCollapsed).toBe(false);
    expect(capturedValue?.collapsed).toBe(false);
  });
});
