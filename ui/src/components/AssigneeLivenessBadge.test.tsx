// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssigneeLivenessBadge } from "./AssigneeLivenessBadge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AssigneeLivenessBadge", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function render(node: React.ReactNode) {
    const root = createRoot(container);
    act(() => {
      root.render(node);
    });
    return root;
  }

  it("renders nothing for a live assignee (no visual noise)", () => {
    const root = render(<AssigneeLivenessBadge liveness={{ state: "live" }} />);
    expect(container.querySelector('[data-testid="assignee-liveness-badge"]')).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("renders nothing when liveness is absent (no assignee)", () => {
    const root = render(<AssigneeLivenessBadge liveness={null} />);
    expect(container.querySelector('[data-testid="assignee-liveness-badge"]')).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("renders an error chip with the reason in the title", () => {
    const root = render(
      <AssigneeLivenessBadge liveness={{ state: "error", reason: "Process lost -- child pid 93238" }} />,
    );
    const chip = container.querySelector('[data-testid="assignee-liveness-badge"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-liveness-state")).toBe("error");
    expect(chip?.getAttribute("aria-label")).toBe("Assignee in error");
    expect(chip?.textContent).toContain("Assignee in error");
    expect(chip?.getAttribute("title")).toContain("error state");
    expect(chip?.getAttribute("title")).toContain("Process lost");
    act(() => {
      root.unmount();
    });
  });

  it("renders a paused chip", () => {
    const root = render(<AssigneeLivenessBadge liveness={{ state: "paused" }} />);
    const chip = container.querySelector('[data-testid="assignee-liveness-badge"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-liveness-state")).toBe("paused");
    expect(chip?.textContent).toContain("Assignee paused");
    act(() => {
      root.unmount();
    });
  });

  it("renders a stale-heartbeat chip", () => {
    const root = render(<AssigneeLivenessBadge liveness={{ state: "stale_heartbeat" }} />);
    const chip = container.querySelector('[data-testid="assignee-liveness-badge"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-liveness-state")).toBe("stale_heartbeat");
    expect(chip?.textContent).toContain("Assignee stale");
    act(() => {
      root.unmount();
    });
  });
});
