// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StarToggle } from "./StarToggle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

describe("StarToggle", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root?.unmount(); });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(node: React.ReactElement) {
    root = createRoot(container);
    await act(async () => {
      root?.render(node);
    });
  }

  function button() {
    return container.querySelector("button");
  }

  it("labels and announces the unstarred state and toggles toward starred", async () => {
    const onToggle = vi.fn();
    await render(<StarToggle starred={false} resourceName="Alpha" onToggle={onToggle} />);

    const btn = button();
    expect(btn?.getAttribute("aria-label")).toBe("Star Alpha");
    expect(btn?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("labels and announces the starred state and toggles toward unstarred", async () => {
    const onToggle = vi.fn();
    await render(<StarToggle starred resourceName="Alpha" onToggle={onToggle} />);

    const btn = button();
    expect(btn?.getAttribute("aria-label")).toBe("Unstar Alpha");
    expect(btn?.getAttribute("aria-pressed")).toBe("true");
    // A starred (non-quiet) row control is visible at rest.
    expect(btn?.className).toContain("opacity-100");

    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("stays quiet (hidden at rest) for a starred sidebar row", async () => {
    await render(
      <StarToggle starred quiet resourceName="Alpha" onToggle={() => {}} revealClassName="reveal-me" />,
    );
    const btn = button();
    // Quiet: even starred, hidden at rest and revealed via the passed class.
    expect(btn?.className).toContain("reveal-me");
    expect(btn?.className).not.toContain("opacity-100");
  });

  it("blocks input and spins while pending", async () => {
    const onToggle = vi.fn();
    await render(<StarToggle starred={false} pending resourceName="Alpha" onToggle={onToggle} />);
    const btn = button();
    expect(btn?.hasAttribute("disabled")).toBe(true);
    expect(btn?.getAttribute("aria-busy")).toBe("true");
    await act(async () => { btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("surfaces an icon-only retry affordance on error for the detail variant", async () => {
    await render(<StarToggle starred size="button" error resourceName="Alpha" onToggle={() => {}} />);
    const btn = button();
    expect(btn?.textContent).toBe("");
    expect(btn?.getAttribute("data-variant")).toBe("ghost");
    expect(btn?.getAttribute("title")).toBe("Couldn't save — retry");
  });

  it("renders the unstarred detail variant as an unfilled icon without an outline", async () => {
    await render(<StarToggle starred={false} size="button" resourceName="Alpha" onToggle={() => {}} />);
    const btn = button();
    expect(btn?.textContent).toBe("");
    expect(btn?.getAttribute("data-variant")).toBe("ghost");
    expect(btn?.getAttribute("aria-label")).toBe("Star Alpha");
    expect(btn?.querySelector("svg")?.getAttribute("class")).not.toContain("fill-amber-500");
  });

  it("renders the detail variant as a filled, icon-only star without an outline", async () => {
    await render(<StarToggle starred size="button" resourceName="Alpha" onToggle={() => {}} />);
    const btn = button();
    expect(btn?.textContent).toBe("");
    expect(btn?.getAttribute("data-variant")).toBe("ghost");
    expect(btn?.getAttribute("data-size")).toBe("icon-sm");
    expect(btn?.getAttribute("aria-label")).toBe("Unstar Alpha");
    expect(btn?.querySelector("svg")?.getAttribute("class")).toContain("fill-amber-500");
  });
});
