// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostCell } from "./CostCell";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CostCell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the unpriced fallback with a muted class and aria-label when cents is null", () => {
    act(() => {
      root.render(<CostCell cents={null} />);
    });
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("unpriced");
    expect(span!.getAttribute("aria-label")).toBe("cost not available");
    expect(span!.className).toContain("text-muted-foreground");
  });

  it("renders the unpriced fallback when cents is undefined", () => {
    act(() => {
      root.render(<CostCell cents={undefined} />);
    });
    expect(container.textContent).toBe("unpriced");
  });

  it("respects a custom unpricedFallback", () => {
    act(() => {
      root.render(<CostCell cents={null} unpricedFallback="n/a" />);
    });
    expect(container.textContent).toBe("n/a");
  });

  it("renders $0.00 by default for a genuine zero (no fallback distinction)", () => {
    act(() => {
      root.render(<CostCell cents={0} />);
    });
    expect(container.textContent).toBe("$0.00");
    const span = container.querySelector("span");
    expect(span!.getAttribute("aria-label")).toBeNull();
  });

  it("renders a custom freeFallback when provided and cents is exactly zero", () => {
    act(() => {
      root.render(<CostCell cents={0} freeFallback="free" />);
    });
    expect(container.textContent).toBe("free");
  });

  it("renders a formatted dollar amount for a positive cents value", () => {
    act(() => {
      root.render(<CostCell cents={12345} />);
    });
    expect(container.textContent).toBe("$123.45");
  });

  it("forwards className", () => {
    act(() => {
      root.render(<CostCell cents={500} className="font-semibold" />);
    });
    const span = container.querySelector("span");
    expect(span!.className).toContain("font-semibold");
  });
});
