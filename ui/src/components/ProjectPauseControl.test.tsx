// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPauseControl } from "./ProjectPauseControl";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectPauseControl", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a pause action for active projects", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ProjectPauseControl
          projectRef="proj-1"
          paused={false}
          pauseReason={null}
          onPause={() => undefined}
          onResume={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Pause");

    act(() => {
      root.unmount();
    });
  });

  it("renders a resume action for manually paused projects", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ProjectPauseControl
          projectRef="proj-1"
          paused
          pauseReason="manual"
          onPause={() => undefined}
          onResume={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Resume");

    act(() => {
      root.unmount();
    });
  });

  it("routes budget-paused projects to the budget tab instead of rendering resume", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ProjectPauseControl
          projectRef="proj-1"
          paused
          pauseReason="budget"
          onPause={() => undefined}
          onResume={() => undefined}
        />,
      );
    });

    const link = container.querySelector('a[href="/projects/proj-1/budget"]');
    expect(link?.textContent).toContain("Resolve budget");
    expect(container.textContent).not.toContain("Resume");

    act(() => {
      root.unmount();
    });
  });
});
