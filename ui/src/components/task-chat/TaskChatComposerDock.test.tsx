// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatComposerDock } from "./TaskChatComposerDock";

describe("TaskChatComposerDock", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(coordinator = true) {
    const onTranscriptWheel = vi.fn();
    flushSync(() => root.render(
      <div className={coordinator ? "coordinator-workspace" : undefined}>
        <div data-testid="task-chat-thread">
          <div data-testid="task-chat-scroller" onWheel={onTranscriptWheel} />
          <TaskChatComposerDock mobile={false} streamlined>
            <textarea aria-label="Message" />
          </TaskChatComposerDock>
        </div>
      </div>,
    ));
    const dock = container.querySelector<HTMLDivElement>('[data-testid="task-chat-composer-dock"]')!;
    const scroller = container.querySelector<HTMLDivElement>('[data-testid="task-chat-scroller"]')!;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy;
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ lineHeight: "24px" } as CSSStyleDeclaration);
    return { dock, scroller, scrollBy, onTranscriptWheel };
  }

  it.each([
    [WheelEvent.DOM_DELTA_PIXEL, 30],
    [WheelEvent.DOM_DELTA_LINE, 720],
    [WheelEvent.DOM_DELTA_PAGE, 12000],
  ])("scrolls the transcript from a footer gap with delta mode %i", (deltaMode, top) => {
    const { dock, scrollBy, onTranscriptWheel } = render();
    const event = new WheelEvent("wheel", { deltaY: -30, deltaMode, bubbles: true, cancelable: true });

    dock.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith({ top: -top, left: 0, behavior: "instant" });
    expect(onTranscriptWheel).toHaveBeenCalledOnce();
    expect(onTranscriptWheel.mock.calls[0][0].deltaY).toBe(-30);
  });

  it("keeps editor scrolling and zoom gestures with their original targets", () => {
    const { dock, scrollBy, onTranscriptWheel } = render();
    const editorEvent = new WheelEvent("wheel", { deltaY: 30, bubbles: true, cancelable: true });
    const zoomEvent = new WheelEvent("wheel", { deltaY: 30, ctrlKey: true, bubbles: true, cancelable: true });

    dock.querySelector("textarea")!.dispatchEvent(editorEvent);
    dock.dispatchEvent(zoomEvent);

    expect(editorEvent.defaultPrevented).toBe(false);
    expect(zoomEvent.defaultPrevented).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(onTranscriptWheel).not.toHaveBeenCalled();
  });

  it("preserves the classic workspace wheel behavior", () => {
    const { dock, scrollBy } = render(false);
    const event = new WheelEvent("wheel", { deltaY: 30, bubbles: true, cancelable: true });

    dock.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
