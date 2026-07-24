// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { pinDocumentScrollToZero } from "./pin-document-scroll";

describe("pinDocumentScrollToZero", () => {
  afterEach(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });

  it("snaps documentElement.scrollTop back to 0 when a scroll event fires after it drifts", () => {
    const cleanup = pinDocumentScrollToZero();

    document.documentElement.scrollTop = 250;
    window.dispatchEvent(new Event("scroll"));

    expect(document.documentElement.scrollTop).toBe(0);

    cleanup();
  });

  it("snaps body.scrollTop back to 0 too (some engines target body for the root scroll)", () => {
    const cleanup = pinDocumentScrollToZero();

    document.body.scrollTop = 120;
    window.dispatchEvent(new Event("scroll"));

    expect(document.body.scrollTop).toBe(0);

    cleanup();
  });

  it("leaves scrollTop alone when it is already 0 (no thrash on routine scrolls)", () => {
    const cleanup = pinDocumentScrollToZero();

    const docSetter = vi.spyOn(document.documentElement, "scrollTop", "set");
    const bodySetter = vi.spyOn(document.body, "scrollTop", "set");

    window.dispatchEvent(new Event("scroll"));

    expect(docSetter).not.toHaveBeenCalled();
    expect(bodySetter).not.toHaveBeenCalled();

    docSetter.mockRestore();
    bodySetter.mockRestore();
    cleanup();
  });

  it("registers the listener in capture phase and NOT passive so the reset runs before paint", () => {
    const addSpy = vi.spyOn(window, "addEventListener");

    const cleanup = pinDocumentScrollToZero();

    expect(addSpy).toHaveBeenCalledWith(
      "scroll",
      expect.any(Function),
      // capture: true, no passive flag — a passive listener would let the
      // browser paint the shifted frame before the reset runs.
      { capture: true },
    );

    addSpy.mockRestore();
    cleanup();
  });

  it("cleanup removes the listener — subsequent scroll events do not reset scrollTop", () => {
    const cleanup = pinDocumentScrollToZero();
    cleanup();

    document.documentElement.scrollTop = 75;
    window.dispatchEvent(new Event("scroll"));

    expect(document.documentElement.scrollTop).toBe(75);
  });
});
