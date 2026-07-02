// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/**
 * Interaction coverage for the icon-only status picker (LUN-3068 regression).
 *
 * The PAP-238 unified-glyph refactor passed a StatusGlyph *function component*
 * as the `PopoverTrigger asChild` child. StatusGlyph only accepted its own
 * props, so the trigger props Radix injects via Slot (onClick, aria-haspopup,
 * data-state, ref) were silently dropped and every icon-only status picker —
 * including the issue-detail header control — rendered as a dead <svg>. The
 * static-markup tests in StatusIcon.test.tsx cannot catch that class of bug,
 * so these tests assert the wired-up DOM and the click behaviour.
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

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    globalThis.ResizeObserver = originalResizeObserver!;
    container.remove();
    document.body.innerHTML = "";
  });

  function render(node: React.ReactNode) {
    root = createRoot(container);
    act(() => {
      root!.render(node);
    });
  }

  function glyph(): SVGSVGElement {
    const svg = container.querySelector<SVGSVGElement>("svg[aria-label]");
    expect(svg).not.toBeNull();
    return svg!;
  }

  it("stays read-only without onChange", () => {
    render(<StatusIcon status="in_progress" />);
    const svg = glyph();
    expect(svg.getAttribute("aria-label")).toBe("In Progress");
    expect(svg.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("receives the Radix trigger wiring on the glyph when onChange is set", () => {
    render(<StatusIcon status="in_progress" onChange={() => {}} />);
    const svg = glyph();
    expect(svg.getAttribute("aria-haspopup")).toBe("dialog");
    expect(svg.getAttribute("data-state")).toBe("closed");
  });

  it("opens the status menu on click and reports the pick through onChange", async () => {
    const onChange = vi.fn();
    render(<StatusIcon status="in_progress" onChange={onChange} />);

    click(glyph());
    await flush();

    expect(glyph().getAttribute("data-state")).toBe("open");
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

    click(options.find((option) => option.lastChild?.textContent === "Done")!);
    await flush();

    expect(onChange).toHaveBeenCalledWith("done");
    expect(glyph().getAttribute("data-state")).toBe("closed");
  });
});
