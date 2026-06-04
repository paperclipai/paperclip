// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionErrorBoundary } from "./SectionErrorBoundary";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Boom(): ReactNode {
  throw new Error("kaboom");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SectionErrorBoundary", () => {
  it("renders children when they do not throw", () => {
    act(() => {
      root.render(
        <SectionErrorBoundary label="Activity">
          <div data-testid="ok">healthy content</div>
        </SectionErrorBoundary>,
      );
    });
    expect(container.querySelector('[data-testid="ok"]')).not.toBeNull();
  });

  it("shows an inline fallback instead of crashing when a child throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      act(() => {
        root.render(
          <SectionErrorBoundary label="Activity">
            <Boom />
          </SectionErrorBoundary>,
        );
      }),
    ).not.toThrow();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent ?? "").toContain("couldn’t be displayed");
    errorSpy.mockRestore();
  });

  it("renders a custom fallback when provided", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root.render(
        <SectionErrorBoundary label="Activity row" fallback={null}>
          <Boom />
        </SectionErrorBoundary>,
      );
    });
    // fallback={null} renders nothing — no alert, no crash.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("");
    errorSpy.mockRestore();
  });

  it("recovers after the resetKey changes", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root.render(
        <SectionErrorBoundary label="Activity" resetKey="issue-1">
          <Boom />
        </SectionErrorBoundary>,
      );
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    act(() => {
      root.render(
        <SectionErrorBoundary label="Activity" resetKey="issue-2">
          <div data-testid="recovered">new issue content</div>
        </SectionErrorBoundary>,
      );
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="recovered"]')).not.toBeNull();
    errorSpy.mockRestore();
  });
});
