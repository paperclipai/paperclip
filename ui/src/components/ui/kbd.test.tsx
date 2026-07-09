// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kbd, getModKeyLabel, modComboLabel, modEnterLabel } from "./kbd";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("getModKeyLabel", () => {
  it("returns ⌘ on Apple platforms", () => {
    expect(getModKeyLabel("MacIntel")).toBe("⌘");
    expect(getModKeyLabel("iPhone")).toBe("⌘");
    expect(getModKeyLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("⌘");
  });

  it("returns Ctrl elsewhere", () => {
    expect(getModKeyLabel("Win32")).toBe("Ctrl");
    expect(getModKeyLabel("Linux x86_64")).toBe("Ctrl");
    expect(getModKeyLabel("")).toBe("Ctrl");
  });
});

describe("modComboLabel", () => {
  it("omits the separator on Apple platforms", () => {
    expect(modComboLabel("S", "MacIntel")).toBe("⌘S");
  });

  it("adds a + separator elsewhere", () => {
    expect(modComboLabel("S", "Win32")).toBe("Ctrl+S");
    expect(modComboLabel("S", "Linux x86_64")).toBe("Ctrl+S");
  });
});

describe("modEnterLabel", () => {
  it("joins the platform modifier with the return symbol", () => {
    expect(modEnterLabel("MacIntel")).toBe("⌘↵");
    expect(modEnterLabel("Win32")).toBe("Ctrl+↵");
  });
});

describe("Kbd", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders its children in a kbd element", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Kbd>⌘↵</Kbd>);
    });
    const kbd = container.querySelector("kbd");
    expect(kbd).toBeTruthy();
    expect(kbd?.textContent).toBe("⌘↵");
    act(() => root.unmount());
  });

  it("is hidden from assistive tech by default (decorative hint)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Kbd>⌘↵</Kbd>);
    });
    expect(container.querySelector("kbd")?.getAttribute("aria-hidden")).toBe("true");
    act(() => root.unmount());
  });

  it("merges custom classNames", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Kbd className="ml-2">S</Kbd>);
    });
    expect(container.querySelector("kbd")?.className).toContain("ml-2");
    act(() => root.unmount());
  });
});
