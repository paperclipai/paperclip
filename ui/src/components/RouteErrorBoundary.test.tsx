// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

const navigateMock = vi.hoisted(() => vi.fn());
const routerLocation = vi.hoisted(() => ({ current: { pathname: "/co/agents/new", search: "?adapterType=claude_local" } }));

vi.mock("@/lib/router", () => ({
  useLocation: () => routerLocation.current,
  useNavigate: () => navigateMock,
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
  });

  it("renders a recoverable error card instead of a blank page when a child throws", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <RouteErrorBoundary>
          <Boom />
        </RouteErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("This page hit an error");
    expect(container.textContent).toContain("Maximum update depth exceeded");
    expect(container.querySelector("pre")).not.toBeNull();

    act(() => {
      root.unmount();
    });
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
    expect(container.textContent).toContain("This page hit an error");

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
