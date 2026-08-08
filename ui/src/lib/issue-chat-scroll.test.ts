// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  captureComposerViewportSnapshot,
  isWindowScrollable,
  restoreComposerViewportSnapshot,
  shouldPreserveComposerViewport,
} from "./issue-chat-scroll";

function mockTop(element: HTMLElement, top: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top,
    bottom: top + 48,
    left: 0,
    right: 0,
    width: 0,
    height: 48,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("issue-chat-scroll", () => {
  it("restores page scroll when the composer shifts in the viewport", () => {
    const composer = document.createElement("div");
    document.body.appendChild(composer);
    const scrollByMock = vi.spyOn(window, "scrollBy").mockImplementation(() => {});

    mockTop(composer, 420);
    const snapshot = captureComposerViewportSnapshot(composer);

    mockTop(composer, 560);
    restoreComposerViewportSnapshot(snapshot, composer);

    expect(scrollByMock).toHaveBeenCalledWith({ top: 140, left: 0, behavior: "auto" });

    scrollByMock.mockRestore();
    composer.remove();
  });

  it("does not scroll the window when the document body is overflow:hidden (desktop shell)", () => {
    // The desktop app shell pins the body to overflow:hidden inside a fixed
    // h-dvh flex column, so a window scroll would translate the whole shell
    // (sidebar included) off-screen — paperclipai/paperclip#7972.
    const composer = document.createElement("div");
    document.body.appendChild(composer);
    document.body.style.overflow = "hidden";
    const scrollByMock = vi.spyOn(window, "scrollBy").mockImplementation(() => {});

    mockTop(composer, 420);
    const snapshot = captureComposerViewportSnapshot(composer);

    mockTop(composer, 560);
    restoreComposerViewportSnapshot(snapshot, composer);

    expect(scrollByMock).not.toHaveBeenCalled();

    scrollByMock.mockRestore();
    document.body.style.overflow = "";
    composer.remove();
  });

  it("reports the document as scrollable only when the body is not clipped", () => {
    document.body.style.overflow = "";
    expect(isWindowScrollable()).toBe(true);

    document.body.style.overflow = "hidden";
    expect(isWindowScrollable()).toBe(false);

    document.body.style.overflow = "";
  });

  it("restores main-content scroll when the layout uses an internal scroller", () => {
    const mainContent = document.createElement("main");
    mainContent.id = "main-content";
    mainContent.style.overflowY = "auto";
    Object.defineProperty(mainContent, "scrollHeight", {
      configurable: true,
      value: 1800,
    });
    Object.defineProperty(mainContent, "clientHeight", {
      configurable: true,
      value: 900,
    });
    mainContent.scrollTop = 240;
    document.body.appendChild(mainContent);

    const composer = document.createElement("div");
    document.body.appendChild(composer);
    const scrollByMock = vi.spyOn(window, "scrollBy").mockImplementation(() => {});

    mockTop(composer, 300);
    const snapshot = captureComposerViewportSnapshot(composer);

    mockTop(composer, 380);
    restoreComposerViewportSnapshot(snapshot, composer);

    expect(mainContent.scrollTop).toBe(320);
    expect(scrollByMock).not.toHaveBeenCalled();

    scrollByMock.mockRestore();
    composer.remove();
    mainContent.remove();
  });

  it("does not preserve the composer viewport just because the composer is visible", () => {
    const composer = document.createElement("div");
    document.body.appendChild(composer);
    mockTop(composer, 540);

    expect(shouldPreserveComposerViewport(composer)).toBe(false);

    composer.remove();
  });

  it("preserves the composer viewport when focus stays inside the composer", () => {
    const composer = document.createElement("div");
    const input = document.createElement("textarea");
    composer.appendChild(input);
    document.body.appendChild(composer);
    mockTop(composer, 1200);

    input.focus();

    expect(shouldPreserveComposerViewport(composer)).toBe(true);

    composer.remove();
  });
});
