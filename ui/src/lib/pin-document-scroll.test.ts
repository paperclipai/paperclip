// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { pinDocumentScrollToZero } from "./pin-document-scroll";

describe("pinDocumentScrollToZero", () => {
  afterEach(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });

  it("snaps documentElement.scrollTop back to 0 when a scroll event fires", () => {
    const cleanup = pinDocumentScrollToZero();

    document.documentElement.scrollTop = 250;
    window.dispatchEvent(new Event("scroll"));

    expect(document.documentElement.scrollTop).toBe(0);

    cleanup();
  });

  it("snaps body.scrollTop back to 0 too", () => {
    const cleanup = pinDocumentScrollToZero();

    document.body.scrollTop = 120;
    window.dispatchEvent(new Event("scroll"));

    expect(document.body.scrollTop).toBe(0);

    cleanup();
  });

  it("leaves scrollTop alone when it is already 0", () => {
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

  it("cleanup removes the listener", () => {
    const cleanup = pinDocumentScrollToZero();
    cleanup();

    document.documentElement.scrollTop = 75;
    window.dispatchEvent(new Event("scroll"));

    expect(document.documentElement.scrollTop).toBe(75);
  });
});
