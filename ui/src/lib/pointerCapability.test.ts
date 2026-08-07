// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NO_HOVER_CLASS,
  looksTouchOnly,
  resetPointerCapabilityDetectionForTests,
  startPointerCapabilityDetection,
} from "./pointerCapability";

// Mutable media state driving the matchMedia mock, mirroring SidebarContext.test.
const mediaState = { anyHover: true, anyCoarse: false };
const changeListeners = new Set<(e: MediaQueryListEvent) => void>();

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const matches = query.includes("any-hover")
        ? mediaState.anyHover
        : query.includes("any-pointer: coarse")
          ? mediaState.anyCoarse
          : false;
      return {
        matches,
        media: query,
        addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
          changeListeners.add(cb);
        },
        removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
          changeListeners.delete(cb);
        },
      } as unknown as MediaQueryList;
    },
  });
}

/** Simulate iPadOS finally reporting hover capability. */
function fireHoverMediaChange(matches: boolean) {
  mediaState.anyHover = matches;
  for (const cb of [...changeListeners]) cb({ matches } as MediaQueryListEvent);
}

function pointerEvent(type: string, pointerType: string) {
  // jsdom lacks PointerEvent, so synthesize one carrying `pointerType`.
  const event = new Event(type, { bubbles: true }) as Event & { pointerType?: string };
  event.pointerType = pointerType;
  return event;
}

/** Touch-only tablet/phone: nothing can hover, and a coarse pointer exists. */
function setTouchOnly() {
  mediaState.anyHover = false;
  mediaState.anyCoarse = true;
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  mediaState.anyHover = true;
  mediaState.anyCoarse = false;
  changeListeners.clear();
  installMatchMedia();
  // jsdom has no PointerEvent; the module feature-detects it, so stub it in.
  (window as unknown as { PointerEvent: unknown }).PointerEvent = function () {} as unknown;
  document.documentElement.classList.remove(NO_HOVER_CLASS);
  resetPointerCapabilityDetectionForTests();
});

afterEach(() => {
  teardown?.();
  teardown = null;
  document.documentElement.classList.remove(NO_HOVER_CLASS);
  resetPointerCapabilityDetectionForTests();
});

describe("looksTouchOnly", () => {
  it("is false on a hover-capable desktop", () => {
    expect(looksTouchOnly()).toBe(false);
  });

  it("is true when nothing can hover and a coarse pointer exists", () => {
    setTouchOnly();
    expect(looksTouchOnly()).toBe(true);
  });

  it("fails open when the platform reports no hover but no coarse pointer either", () => {
    mediaState.anyHover = false;
    mediaState.anyCoarse = false;
    expect(looksTouchOnly()).toBe(false);
  });
});

describe("startPointerCapabilityDetection", () => {
  it("leaves hover enabled on a desktop", () => {
    teardown = startPointerCapabilityDetection();
    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(false);
  });

  it("suppresses hover on a touch-only device", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();
    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(true);
  });

  it("re-enables hover when a real cursor appears (iPadOS trackpad)", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();
    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(true);

    window.dispatchEvent(pointerEvent("pointermove", "mouse"));

    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(false);
  });

  it("re-enables hover on pointerover, before any movement is reported", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();

    window.dispatchEvent(pointerEvent("pointerover", "mouse"));

    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(false);
  });

  it("ignores touch and pen input, so a tap never leaves a stuck highlight", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();

    window.dispatchEvent(pointerEvent("pointermove", "touch"));
    window.dispatchEvent(pointerEvent("pointerover", "touch"));
    window.dispatchEvent(pointerEvent("pointerover", "pen"));

    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(true);
  });

  it("latches: hover stays enabled after the cursor goes away", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();
    window.dispatchEvent(pointerEvent("pointermove", "mouse"));
    // Later touch input must not re-suppress hover for the session.
    window.dispatchEvent(pointerEvent("pointermove", "touch"));

    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(false);
  });

  it("re-enables hover if the hover media query starts matching", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();

    fireHoverMediaChange(true);

    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(false);
  });

  it("stops listening once hover is enabled", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();
    window.dispatchEvent(pointerEvent("pointermove", "mouse"));

    expect(changeListeners.size).toBe(0);
  });

  it("is idempotent", () => {
    setTouchOnly();
    teardown = startPointerCapabilityDetection();
    const second = startPointerCapabilityDetection();
    second();

    // The second call must not have torn down the first one's listeners.
    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(true);
    window.dispatchEvent(pointerEvent("pointermove", "mouse"));
    expect(document.documentElement.classList.contains(NO_HOVER_CLASS)).toBe(false);
  });
});
