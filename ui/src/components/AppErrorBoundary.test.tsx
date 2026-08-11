// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function Boom(): never {
  throw new Error("Cannot read properties of undefined (reading 'title')");
}

describe("AppErrorBoundary", () => {
  let container: HTMLDivElement;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    // React logs caught render errors to console.error; silence the expected noise.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    container.remove();
  });

  it("renders visible fallback UI instead of an empty tree when a descendant throws", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("Cannot read properties of undefined (reading 'title')");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.children.length).toBeGreaterThan(0);

    act(() => {
      root.unmount();
    });
  });

  it("logs the error and component stack via console.error", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Unhandled render error crashed the app",
      expect.objectContaining({
        error: expect.any(Error),
        componentStack: expect.stringContaining("Boom"),
      }),
    );

    act(() => {
      root.unmount();
    });
  });

  it("renders children normally when nothing throws", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <div>All good</div>
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toBe("All good");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("exposes the component stack in a collapsible details section", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <Boom />
        </AppErrorBoundary>,
      );
    });

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain("Boom");

    act(() => {
      root.unmount();
    });
  });
});
