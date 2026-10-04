// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendKeyMenu, SEND_KEY_MENU_CLOSE_DELAY_MS, SEND_KEY_MENU_HOVER_DELAY_MS } from "./SendKeyMenu";
import { getSubmitKeyPreference, useResolvedSubmitKey } from "../lib/submitKeyPreference";

function Harness({ onSend }: { onSend: () => void }) {
  const mode = useResolvedSubmitKey("mod-enter");
  return (
    <div data-testid="mode" data-mode={mode}>
      <SendKeyMenu mode={mode}>
        <button type="button" aria-label="Send" onClick={onSend}>
          Send
        </button>
      </SendKeyMenu>
    </div>
  );
}

describe("SendKeyMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.useFakeTimers();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const menu = () => document.querySelector<HTMLElement>('[data-testid="send-key-menu"]');
  const anchor = () => container.querySelector<HTMLElement>('[data-testid="send-key-menu-anchor"]')!;
  const hover = () =>
    act(() => {
      anchor().dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });

  it("opens after the mouse rests on the button, and saves the chosen key", () => {
    act(() => root.render(<Harness onSend={() => {}} />));
    hover();
    act(() => vi.advanceTimersByTime(SEND_KEY_MENU_HOVER_DELAY_MS - 100));
    expect(menu()).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(menu()).not.toBeNull();

    const current = document.querySelector<HTMLElement>('[data-testid="send-key-menu-mod-enter"]')!;
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(menu()!.textContent).toContain("Shift+Return for a new line");

    act(() => {
      document.querySelector<HTMLElement>('[data-testid="send-key-menu-enter"]')!.click();
    });
    expect(getSubmitKeyPreference()).toBe("enter");
    expect(container.querySelector('[data-testid="mode"]')!.getAttribute("data-mode")).toBe("enter");
    expect(menu()).toBeNull();
  });

  it("does not open when the mouse leaves before the delay", () => {
    act(() => root.render(<Harness onSend={() => {}} />));
    hover();
    act(() => {
      anchor().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    act(() => vi.advanceTimersByTime(SEND_KEY_MENU_HOVER_DELAY_MS * 2));
    expect(menu()).toBeNull();
  });

  it("a plain click still sends and cancels the pending menu", () => {
    const onSend = vi.fn();
    act(() => root.render(<Harness onSend={onSend} />));
    hover();
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
    });
    act(() => vi.advanceTimersByTime(SEND_KEY_MENU_HOVER_DELAY_MS * 2));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("closes shortly after the mouse leaves, but stays while the mouse is on the menu", () => {
    act(() => root.render(<Harness onSend={() => {}} />));
    hover();
    act(() => vi.advanceTimersByTime(SEND_KEY_MENU_HOVER_DELAY_MS));
    expect(menu()).not.toBeNull();

    const leave = (el: HTMLElement) =>
      act(() => {
        el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      });
    const enter = (el: HTMLElement) =>
      act(() => {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      });

    leave(anchor());
    enter(menu()!);
    act(() => vi.advanceTimersByTime(SEND_KEY_MENU_CLOSE_DELAY_MS * 2));
    expect(menu()).not.toBeNull();

    leave(menu()!);
    act(() => vi.advanceTimersByTime(SEND_KEY_MENU_CLOSE_DELAY_MS - 100));
    expect(menu()).not.toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(menu()).toBeNull();
  });

  const pointerDown = (pointerType: string) =>
    act(() => {
      const event = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      anchor().dispatchEvent(event);
    });

  it("does not send on the finger lift after a long press opens the menu", () => {
    const onSend = vi.fn();
    act(() => root.render(<Harness onSend={onSend} />));
    pointerDown("touch");
    act(() => {
      anchor().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(menu()).not.toBeNull();
    const send = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    act(() => {
      send().click();
    });
    expect(onSend).not.toHaveBeenCalled();
    // The next deliberate tap sends again.
    pointerDown("touch");
    act(() => {
      send().click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a mouse right-click does not swallow a later keyboard send", () => {
    const onSend = vi.fn();
    act(() => root.render(<Harness onSend={onSend} />));
    pointerDown("mouse");
    act(() => {
      anchor().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(menu()).not.toBeNull();
    // Enter/Space on a focused button dispatches a click without pointerdown.
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("clears the touch suppression when the menu closes", () => {
    const onSend = vi.fn();
    act(() => root.render(<Harness onSend={onSend} />));
    pointerDown("touch");
    act(() => {
      anchor().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    act(() => {
      document.querySelector<HTMLElement>('[data-testid="send-key-menu-enter"]')!.click();
    });
    expect(menu()).toBeNull();
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("opens on right-click", () => {
    act(() => root.render(<Harness onSend={() => {}} />));
    act(() => {
      anchor().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(menu()).not.toBeNull();
  });
});
