// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

const captureBrowserExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sentry", () => ({
  captureBrowserException: (...args: unknown[]) => captureBrowserExceptionMock(...args),
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
    document.documentElement.classList.remove("translated-ltr");
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
    expect(captureBrowserExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      boundary: "app", componentStack: expect.stringContaining("BoomRender"),
    });
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

  it("preserves the original DOM insertion error and its failing component", () => {
    function BrokenDomInsertion() {
      useEffect(() => {
        document.createElement("div").insertBefore(
          document.createElement("span"), document.createElement("span"),
        );
      }, []);
      return null;
    }
    const root = createRoot(container);
    act(() => root.render(<AppErrorBoundary><BrokenDomInsertion /></AppErrorBoundary>));
    expect(captureBrowserExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "NotFoundError" }),
      { boundary: "app", componentStack: expect.stringContaining("BrokenDomInsertion") },
    );
    expect(container.textContent).toContain("Paperclip hit an error");
    act(() => root.unmount());
  });

  it("reports the component when translation replaces a React-owned insertion anchor", () => {
    function TranslatedStatus({ showIcon }: { showIcon: boolean }) {
      return <div data-testid="translated-status">{showIcon && <span aria-hidden="true" />}Ready</div>;
    }
    const root = createRoot(container);
    act(() => root.render(<AppErrorBoundary><TranslatedStatus showIcon={false} /></AppErrorBoundary>));
    const parent = container.querySelector('[data-testid="translated-status"]')!;
    // Translation replaces the text node; React still holds that old node as
    // the insertion anchor when it later adds a sibling before the text.
    const translated = document.createElement("font");
    translated.textContent = "Translated status";
    parent.replaceChild(translated, parent.firstChild!);
    document.documentElement.classList.add("translated-ltr");
    act(() => root.render(<AppErrorBoundary><TranslatedStatus showIcon /></AppErrorBoundary>));
    expect(captureBrowserExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "NotFoundError" }),
      { boundary: "app", componentStack: expect.stringContaining("TranslatedStatus") },
    );
    expect(container.textContent).toContain("Reload page");
    act(() => root.unmount());
  });
});
