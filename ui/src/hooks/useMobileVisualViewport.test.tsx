// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMobileVisualViewport } from "./useMobileVisualViewport";

function Host({ mobile = true, conversation = true }: { mobile?: boolean; conversation?: boolean }) {
  const ref = useMobileVisualViewport(mobile);
  return <div ref={ref}><div data-task-chat-shell={conversation ? "" : undefined}>Chat shell</div></div>;
}

let root: Root;
let container: HTMLDivElement;
let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerHeight", 695);
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 695 });
  viewport = Object.assign(new EventTarget(), { height: 695, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(document.documentElement, "clientHeight");
  document.documentElement.scrollTop = 0;
  vi.unstubAllGlobals();
});

it("resizes the shell from the visible height when iOS innerHeight shrinks too", () => {
  act(() => root.render(<Host />));
  const shell = container.firstElementChild as HTMLElement;
  act(() => {
    vi.stubGlobal("innerHeight", 358);
    viewport.height = 358;
    viewport.offsetTop = 337;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(shell.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("358px");
  expect(shell.dataset.keyboardOpen).toBe("true");
  // Panning must not translate or resize the shell a second time.
  act(() => { viewport.offsetTop = 185; viewport.dispatchEvent(new Event("scroll")); });
  expect(shell.style.top).toBe("");
  expect(shell.style.transform).toBe("");
  expect(shell.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("358px");
  act(() => { viewport.height = 695; viewport.offsetTop = 0; viewport.dispatchEvent(new Event("resize")); });
  expect(shell.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("695px");
  expect(shell.dataset.keyboardOpen).toBeUndefined();
});

it("preserves pinch zoom and leaves desktop sizing to CSS", () => {
  act(() => root.render(<Host />));
  const shell = container.firstElementChild as HTMLElement;
  act(() => { viewport.scale = 2; viewport.height = 350; viewport.dispatchEvent(new Event("resize")); });
  expect(shell.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("695px");
  act(() => root.render(<Host mobile={false} />));
  expect(shell.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("");
  expect(shell.dataset.keyboardOpen).toBeUndefined();
});

it("does not invalidate shell styles for typing, scrolling, or unchanged viewport events", () => {
  act(() => root.render(<Host />));
  const shell = container.firstElementChild as HTMLElement;
  const observer = new MutationObserver(() => {});
  observer.observe(shell, { attributes: true });
  act(() => {
    for (let i = 0; i < 30; i++) {
      shell.dispatchEvent(new Event("input", { bubbles: true }));
      viewport.dispatchEvent(new Event("scroll"));
      viewport.dispatchEvent(new Event("resize"));
    }
  });
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
});

it("rejects Safari's stale document focus scroll after the keyboard has resized the conversation", () => {
  act(() => root.render(<Host />));
  act(() => {
    viewport.height = 358;
    // Some openings pan before the resize event; others pan one frame later.
    document.documentElement.scrollTop = 337;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(document.documentElement.scrollTop).toBe(0);
  document.documentElement.scrollTop = 337;
  document.dispatchEvent(new Event("scroll"));
  expect(document.documentElement.scrollTop).toBe(0);
});

it("leaves ordinary pages and inner message scrolling alone", () => {
  viewport.height = 358;
  act(() => root.render(<Host conversation={false} />));
  document.documentElement.scrollTop = 337;
  document.dispatchEvent(new Event("scroll"));
  expect(document.documentElement.scrollTop).toBe(337);
  act(() => root.render(<Host />));
  const messages = container.querySelector('[data-task-chat-shell]') as HTMLElement;
  messages.scrollTop = 250;
  messages.dispatchEvent(new Event("scroll"));
  expect(messages.scrollTop).toBe(250);
});

it("does not suppress zoom panning when the keyboard was already open", () => {
  viewport.height = 358;
  act(() => root.render(<Host />));
  viewport.scale = 2;
  viewport.height = 179;
  viewport.dispatchEvent(new Event("resize"));
  document.documentElement.scrollTop = 120;
  document.dispatchEvent(new Event("scroll"));
  expect(document.documentElement.scrollTop).toBe(120);
});
