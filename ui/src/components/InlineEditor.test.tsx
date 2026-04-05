// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueContainedBlurCommit } from "./InlineEditor";

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("../hooks/useAutosaveIndicator", () => ({
  useAutosaveIndicator: () => ({
    state: "idle",
    markDirty: () => {},
    reset: () => {},
    runSave: async (save: () => Promise<void>) => {
      await save();
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("queueContainedBlurCommit", () => {
  let container: HTMLDivElement;
  let inside: HTMLTextAreaElement;
  let outside: HTMLButtonElement;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as typeof window.cancelAnimationFrame;

    container = document.createElement("div");
    inside = document.createElement("textarea");
    outside = document.createElement("button");
    container.appendChild(inside);
    document.body.append(container, outside);
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    container.remove();
    outside.remove();
    vi.useRealTimers();
  });

  async function flushFrames() {
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
  }

  it("commits when focus stays outside the editor container", async () => {
    const onCommit = vi.fn();
    const cancel = queueContainedBlurCommit(container, onCommit);

    outside.focus();
    await flushFrames();

    expect(onCommit).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("skips the commit when focus returns inside before the delayed check completes", async () => {
    const onCommit = vi.fn();
    const cancel = queueContainedBlurCommit(container, onCommit);

    outside.focus();
    inside.focus();
    await flushFrames();

    expect(onCommit).not.toHaveBeenCalled();
    cancel();
  });
});
