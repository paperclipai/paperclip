// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectPauseIndicator } from "./ProjectPauseIndicator";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectPauseIndicator", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a neutral badge for manually paused projects", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<ProjectPauseIndicator paused pauseReason="manual" />);
    });

    expect(container.textContent).toContain("Paused");
    expect(container.textContent).not.toContain("budget");

    act(() => {
      root.unmount();
    });
  });

  it("renders a budget badge for budget-paused projects", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<ProjectPauseIndicator paused pauseReason="budget" />);
    });

    expect(container.textContent).toContain("Paused by budget hard stop");

    act(() => {
      root.unmount();
    });
  });

  it("renders a sidebar marker for manually paused projects", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<ProjectPauseIndicator paused pauseReason="manual" variant="sidebar" />);
    });

    const marker = container.querySelector('[aria-label="Project paused"]');
    expect(marker).toBeTruthy();

    act(() => {
      root.unmount();
    });
  });
});
