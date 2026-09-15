// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

const captureBrowserExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sentry", () => ({
  captureBrowserException: (error: unknown) => captureBrowserExceptionMock(error),
}));

function BoomRender(): never {
  throw new Error("Maximum update depth exceeded");
}

function BoomEffect() {
  useEffect(() => {
    throw new Error("effect exploded");
  }, []);
  return null;
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
    captureBrowserExceptionMock.mockClear();
  });

  it("reports one captured error and keeps the reload prompt", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <BoomRender />
        </AppErrorBoundary>,
      );
    });

    expect(captureBrowserExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureBrowserExceptionMock).toHaveBeenCalledWith(expect.any(Error));
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Reload page",
      ),
    ).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it("renders a reload prompt instead of a blank page when the shell throws in render", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <BoomRender />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Paperclip hit an error");
    expect(container.textContent).toContain("Maximum update depth exceeded");
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Reload page",
      ),
    ).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it("catches errors thrown from effects, not just render", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <BoomEffect />
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Paperclip hit an error");
    expect(container.textContent).toContain("effect exploded");

    act(() => {
      root.unmount();
    });
  });

  it("renders children untouched when nothing throws", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <AppErrorBoundary>
          <div>healthy app</div>
        </AppErrorBoundary>,
      );
    });

    expect(container.textContent).toBe("healthy app");

    act(() => {
      root.unmount();
    });
  });
});
