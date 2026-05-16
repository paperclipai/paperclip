// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleMainContentFocus,
  shouldFocusMainContentAfterNavigation,
} from "./main-content-focus";

describe("main-content-focus", () => {
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    document.body.innerHTML = "";
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) => window.clearTimeout(handle)) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("prefers the main content when navigation leaves focus outside it", async () => {
    const sidebarButton = document.createElement("button");
    const main = document.createElement("main");
    main.tabIndex = -1;
    document.body.append(sidebarButton, main);
    sidebarButton.focus();

    scheduleMainContentFocus(main);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.activeElement).toBe(main);
  });

  it("does not steal focus from an active element already inside main content", async () => {
    const main = document.createElement("main");
    const input = document.createElement("input");
    main.tabIndex = -1;
    main.appendChild(input);
    document.body.append(main);
    input.focus();

    scheduleMainContentFocus(main);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.activeElement).toBe(input);
  });

  it("treats disconnected elements as needing main-content focus", () => {
    const main = document.createElement("main");
    main.tabIndex = -1;
    document.body.append(main);

    const staleButton = document.createElement("button");
    staleButton.focus();

    expect(shouldFocusMainContentAfterNavigation(main, staleButton)).toBe(true);
  });
});
