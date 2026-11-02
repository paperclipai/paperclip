// @vitest-environment jsdom

import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChunkLoadRecovery, RELOAD_ABANDONED_MS } from "@/lib/chunk-load-recovery";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

const navigateMock = vi.hoisted(() => vi.fn());
const routerLocation = vi.hoisted(() => ({ current: { pathname: "/co/agents/new", search: "?adapterType=claude_local" } }));
const captureBrowserExceptionMock = vi.hoisted(() => vi.fn());
const reloadMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useLocation: () => routerLocation.current,
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/sentry", () => ({
  captureBrowserException: (...args: unknown[]) => captureBrowserExceptionMock(...args),
}));

const chunkRecovery = vi.hoisted(() => ({
  current: null as null | ReturnType<typeof import("@/lib/chunk-load-recovery").createChunkLoadRecovery>,
}));

vi.mock("@/lib/chunk-load-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chunk-load-recovery")>();
  return {
    ...actual,
    reloadForChunkLoadError: (error: unknown) => chunkRecovery.current!.reloadForChunkLoadError(error),
    onChunkLoadReloadAbandoned: (listener: () => void) => chunkRecovery.current!.onChunkLoadReloadAbandoned(listener),
  };
});

function Boom(): never {
  throw new Error("Maximum update depth exceeded");
}

describe("RouteErrorBoundary", () => {
  let container: HTMLDivElement;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigateMock.mockReset();
    routerLocation.current = { pathname: "/co/agents/new", search: "?adapterType=claude_local" };
    reloadMock.mockReset();
    window.sessionStorage.clear();
    chunkRecovery.current = createChunkLoadRecovery({ reload: reloadMock });
    container = document.createElement("div");
    document.body.appendChild(container);
    // React logs caught render errors to console.error; silence the expected noise.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    container.remove();
    captureBrowserExceptionMock.mockClear();
  });

  it("keeps the surrounding shell mounted while a route loads", async () => {
    let resolve!: (module: { default: () => React.JSX.Element }) => void;
    const PendingPage = lazy(() => new Promise<{ default: () => React.JSX.Element }>((done) => { resolve = done; }));
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <>
          <nav>Task navigation</nav>
          <RouteErrorBoundary><PendingPage /></RouteErrorBoundary>
        </>,
      );
    });
    const shell = container.querySelector("nav");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
    expect(shell?.textContent).toBe("Task navigation");
    await act(async () => { resolve({ default: () => <div>Loaded page</div> }); });
    expect(container.querySelector("nav")).toBe(shell);
    expect(container.textContent).toContain("Loaded page");
    expect(container.querySelector('[role="status"]')).toBeNull();
    act(() => root.unmount());
  });

  it("reloads once for a failed route CSS preload instead of reporting it", async () => {
    const FailedPage = lazy(async () => {
      throw new Error("Unable to preload CSS for https://paperclip.example/assets/issue-detail-CIbQo9zW.css");
    });
    const root = createRoot(container);
    await act(async () => { root.render(<RouteErrorBoundary><FailedPage /></RouteErrorBoundary>); });
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(captureBrowserExceptionMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("This page hit an error");
    act(() => root.unmount());
  });

  it("shows and reports the error when the recovery reload is cancelled", async () => {
    vi.useFakeTimers();
    try {
      const FailedPage = lazy(async () => {
        throw new Error("Unable to preload CSS for https://paperclip.example/assets/issue-detail-CIbQo9zW.css");
      });
      const root = createRoot(container);
      await act(async () => { root.render(<RouteErrorBoundary><FailedPage /></RouteErrorBoundary>); });
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");

      act(() => { vi.advanceTimersByTime(RELOAD_ABANDONED_MS); });
      expect(container.textContent).toContain("This page hit an error");
      expect(container.textContent).toContain("Unable to preload CSS");
      expect(captureBrowserExceptionMock).toHaveBeenCalledTimes(1);
      expect(captureBrowserExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
        boundary: "route", componentStack: expect.any(String),
      });

      const AnotherFailedPage = lazy(async () => { throw new Error("Failed to fetch dynamically imported module"); });
      routerLocation.current = { pathname: "/co/issues/CO-1", search: "" };
      await act(async () => { root.render(<RouteErrorBoundary><AnotherFailedPage /></RouteErrorBoundary>); });
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(captureBrowserExceptionMock).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Failed to fetch dynamically imported module");
      act(() => root.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a repeated chunk load failure and recovers when navigating back to a task", async () => {
    window.sessionStorage.setItem("paperclip:chunk-load-reload-at", String(Date.now()));
    const FailedPage = lazy(async () => { throw new Error("Failed to fetch dynamically imported module"); });
    const root = createRoot(container);
    await act(async () => { root.render(<RouteErrorBoundary><FailedPage /></RouteErrorBoundary>); });
    expect(reloadMock).not.toHaveBeenCalled();
    expect(captureBrowserExceptionMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("This page hit an error");
    routerLocation.current = { pathname: "/co/issues/CO-1", search: "" };
    await act(async () => { root.render(<RouteErrorBoundary><div>Saved conversation</div></RouteErrorBoundary>); });
    expect(container.textContent).toContain("Saved conversation");
    expect(container.textContent).not.toContain("This page hit an error");
    act(() => root.unmount());
  });

  it("navigates back when the user clicks Go back", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <RouteErrorBoundary>
          <Boom />
        </RouteErrorBoundary>,
      );
    });

    const goBack = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Go back",
    );
    expect(goBack).toBeDefined();

    act(() => {
      goBack?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith(-1);

    act(() => {
      root.unmount();
    });
  });

  it("recovers and renders children again after the route changes", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <RouteErrorBoundary>
          <Boom />
        </RouteErrorBoundary>,
      );
    });

    expect(captureBrowserExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureBrowserExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      boundary: "route", componentStack: expect.stringContaining("Boom"),
    });
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Go back",
      ),
    ).toBe(true);

    expect(container.textContent).toContain("This page hit an error");
    expect(container.textContent).toContain("Maximum update depth exceeded");
    expect(container.querySelector("pre")).not.toBeNull();

    // Simulate back-navigation to a different route, then re-render with a
    // healthy child — the boundary should reset off the new resetKey.
    routerLocation.current = { pathname: "/co/agents", search: "" };
    act(() => {
      root.render(
        <RouteErrorBoundary>
          <div>Agents list</div>
        </RouteErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Agents list");
    expect(container.textContent).not.toContain("This page hit an error");

    act(() => {
      root.unmount();
    });
  });
});
