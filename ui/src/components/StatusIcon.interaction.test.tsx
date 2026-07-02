// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Poll `assertion` across macrotask ticks (inside React's `act`) so work that
 * Radix or React schedules beyond the microtask queue — timeouts, rAF,
 * transitions — has landed before the test asserts on it.
 */
async function waitFor(assertion: () => void, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/**
 * Interaction coverage for the icon-only status picker (regression guard).
 *
 * The PAP-238 unified-glyph refactor passed a StatusGlyph *function component*
 * as the `PopoverTrigger asChild` child. StatusGlyph only accepted its own
 * props, so the trigger props Radix injects via Slot (onClick, aria-haspopup,
 * data-state, ref) were silently dropped and every icon-only status picker —
 * including the issue-detail header control — rendered as a dead <svg>. The
 * static-markup tests in StatusIcon.test.tsx cannot catch that class of bug,
 * so these tests assert the wired-up DOM and the click behaviour. The
 * icon-only trigger is now a real <button> (focusable, valid ARIA) with a
 * decorative glyph inside it.
 */
describe("StatusIcon icon-only popover trigger", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    globalThis.ResizeObserver = originalResizeObserver!;
    container.remove();
    document.body.innerHTML = "";
  });

  async function render(node: React.ReactNode) {
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
  }

  function trigger(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>("button[aria-label]");
    expect(button).not.toBeNull();
    return button!;
  }

  it("stays a read-only labelled glyph without onChange", async () => {
    await render(<StatusIcon status="in_progress" />);
    const svg = container.querySelector<SVGSVGElement>("svg[aria-label]");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-label")).toBe("In Progress");
    expect(svg!.getAttribute("role")).toBe("img");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[aria-haspopup]")).toBeNull();
  });

  it("renders a focusable button trigger with valid ARIA when onChange is set", async () => {
    await render(<StatusIcon status="in_progress" onChange={() => {}} />);
    const button = trigger();
    expect(button.getAttribute("aria-label")).toBe("In Progress");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("data-state")).toBe("closed");
    // The glyph inside the trigger is decorative — no role="img"/aria-haspopup
    // conflict (ARIA 1.2: img is not an interactive role) and no double label.
    const svg = button.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.hasAttribute("role")).toBe(false);
    expect(svg!.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("opens the status menu on click and reports the pick through onChange", async () => {
    const onChange = vi.fn();
    await render(<StatusIcon status="in_progress" onChange={onChange} />);

    await click(trigger());
    await waitFor(() => {
      expect(trigger().getAttribute("data-state")).toBe("open");
    });

    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-slot=popover-content] button"),
    );
    // Each row is [<svg> glyph, label text node]; textContent would also pick
    // up the glyph's <title>, so read the label node.
    expect(options.map((option) => option.lastChild?.textContent)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Cancelled",
      "Blocked",
    ]);

    await click(options.find((option) => option.lastChild?.textContent === "Done")!);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("done");
      expect(trigger().getAttribute("data-state")).toBe("closed");
    });
  });
});
