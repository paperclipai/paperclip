import type { MouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { openInPlace } from "./open-in-place";

function click(overrides: Partial<MouseEvent<HTMLAnchorElement>> = {}) {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as MouseEvent<HTMLAnchorElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

describe("openInPlace", () => {
  it("opens a plain click in place", () => {
    const onOpen = vi.fn();
    const event = click();
    openInPlace(event, "/PAP/issues/PAP-1", onOpen);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("/PAP/issues/PAP-1");
  });

  it.each([
    ["ctrl-click", { ctrlKey: true }],
    ["cmd-click", { metaKey: true }],
    ["shift-click", { shiftKey: true }],
    ["alt-click", { altKey: true }],
    ["middle-click", { button: 1 }],
  ])("leaves a %s to the browser", (_name, overrides) => {
    const onOpen = vi.fn();
    const event = click(overrides);
    openInPlace(event, "/PAP/issues/PAP-1", onOpen);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
