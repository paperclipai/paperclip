// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider, useSidebar } from "../context/SidebarContext";
import { RequestCollapsedSidebar } from "./RequestCollapsedSidebar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";

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

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  flushSync(() => {});
}

async function render(onRoute: boolean): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<Harness onRoute={onRoute} />));
  await flushReact();
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

  afterEach(() => {
    if (active) {
      flushSync(() => active!.root.unmount());
      active.host.remove();
      active = null;
    }
    localStorage.clear();
  });

  it("requests collapsed while mounted when there is no user pin", async () => {
    active = await render(true);
    expect(capturedValue?.routeRequestsCollapsed).toBe(true);
    expect(capturedValue?.collapsed).toBe(true);
  });

  it("lets an explicit user pin override the route request", async () => {
    active = await render(true);
    expect(capturedValue?.collapsed).toBe(true);

    // User explicitly pins expanded — must win over the route's request.
    flushSync(() => capturedValue?.setCollapsed(false));
    expect(capturedValue?.routeRequestsCollapsed).toBe(true);
    expect(capturedValue?.collapsed).toBe(false);
  });

  it("clears the request on unmount, restoring the global default", async () => {
    active = await render(true);
    expect(capturedValue?.collapsed).toBe(true);

    // Navigate away: the route (and its <RequestCollapsedSidebar/>) unmounts.
    flushSync(() => active!.root.render(<Harness onRoute={false} />));
    await flushReact();
    expect(capturedValue?.routeRequestsCollapsed).toBe(false);
    expect(capturedValue?.collapsed).toBe(false);
  });

  it("keeps a user pin after navigating away (pin persists, request cleared)", async () => {
    active = await render(true);
    flushSync(() => capturedValue?.setCollapsed(true));
    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("1");

    flushSync(() => active!.root.render(<Harness onRoute={false} />));
    await flushReact();
    // Route request gone, but the explicit collapsed pin still applies.
    expect(capturedValue?.routeRequestsCollapsed).toBe(false);
    expect(capturedValue?.collapsed).toBe(true);
  });
});
