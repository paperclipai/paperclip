// @vitest-environment jsdom

import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

const navigateMock = vi.hoisted(() => vi.fn());
const routerLocation = vi.hoisted(() => ({ current: { pathname: "/co/agents/new", search: "?adapterType=claude_local" } }));
const captureBrowserExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useLocation: () => routerLocation.current,
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/sentry", () => ({
  captureBrowserException: (...args: unknown[]) => captureBrowserExceptionMock(...args),
}));

function Boom(): never {
  throw new Error("Maximum update depth exceeded");
}

describe("RouteErrorBoundary", () => {
  let container: HTMLDivElement;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    navigateMock.mockReset();
    routerLocation.current = { pathname: "/co/agents/new", search: "?adapterType=claude_local" };
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

  it("contains a failed chunk load and recovers when navigating back to a task", async () => {
    const FailedPage = lazy(async () => { throw new Error("Failed to fetch dynamically imported module"); });
    const root = createRoot(container);
    await act(async () => { root.render(<RouteErrorBoundary><FailedPage /></RouteErrorBoundary>); });
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
