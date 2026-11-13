// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS } from "@/hooks/useIssueNavigationPrefetch";
import { RecentTaskNavItem } from "./RecentTaskNavItem";

const prefetches = vi.hoisted(() => [] as Array<{ ref: string; history: boolean }>);
const setSidebarOpen = vi.hoisted(() => vi.fn());
vi.mock("@/lib/issueDetailCache", () => ({
  prefetchIssueDetailForNavigation: (_client: unknown, ref: string, options?: { history?: boolean }) => {
    prefetches.push({ ref, history: options?.history === true });
    return Promise.resolve();
  },
}));
vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, end: _end, state: _state, ...props }: {
    children: ReactNode; to: string; end?: boolean; state?: unknown;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>
  ),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ collapsed: false, peeking: false, isMobile: true, setSidebarOpen }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const queryClient = new QueryClient();

function renderItem(task: { id: string; identifier: string | null }, to?: string) {
  prefetches.length = 0;
  act(() => {
    root.render(<QueryClientProvider client={queryClient}><RecentTaskNavItem task={task} to={to} label="Recent task" /></QueryClientProvider>);
  });
  return container.querySelector("a") as HTMLAnchorElement;
}
const hover = (link: HTMLAnchorElement, type: "mouseover" | "mouseout") =>
  act(() => { link.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body })); });
const press = (link: HTMLAnchorElement, pointerType: string) =>
  act(() => { link.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType })); });

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  setSidebarOpen.mockClear();
});

describe("RecentTaskNavItem", () => {
  it("opens and warms the identifier route, falling back to the id", () => {
    expect(renderItem({ id: "id-1", identifier: "PAP-1" }).getAttribute("href")).toBe("/issues/PAP-1");
    expect(renderItem({ id: "id-2", identifier: null }).getAttribute("href")).toBe("/issues/id-2");
    expect(renderItem({ id: "id-1", identifier: "PAP-1" }, "/PAP/issues/PAP-1").getAttribute("href")).toBe("/PAP/issues/PAP-1");
  });

  it("warms only the light set when a pointer passes over, and the chat's first frame when it rests", () => {
    const link = renderItem({ id: "id-1", identifier: "PAP-1" });
    hover(link, "mouseover");
    act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS - 1); });
    hover(link, "mouseout");
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(prefetches).toEqual([{ ref: "PAP-1", history: false }]);
    hover(link, "mouseover");
    act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS); });
    expect(prefetches.at(-1)).toEqual({ ref: "PAP-1", history: true });
  });

  it("warms the first frame on a mouse press, keyboard focus that rests, and a click", () => {
    const link = renderItem({ id: "id-1", identifier: "PAP-1" });
    press(link, "mouse");
    expect(prefetches).toEqual([{ ref: "PAP-1", history: true }]);
    prefetches.length = 0;
    act(() => { link.focus(); });
    act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS); });
    expect(prefetches).toEqual([{ ref: "PAP-1", history: false }, { ref: "PAP-1", history: true }]);
    prefetches.length = 0;
    act(() => { link.click(); });
    expect(prefetches).toEqual([{ ref: "PAP-1", history: true }]);
    // The sidebar's own click handling still runs.
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("keeps a touch that may start a scroll to the light set", () => {
    const link = renderItem({ id: "id-1", identifier: "PAP-1" });
    press(link, "touch");
    act(() => { link.dispatchEvent(new TouchEvent("touchstart", { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(prefetches.length).toBeGreaterThan(0);
    expect(prefetches.every((prefetch) => !prefetch.history)).toBe(true);
  });
});
