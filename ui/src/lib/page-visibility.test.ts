// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPageVisibility,
  getVisibilityHeaderValue,
  subscribePageVisibility,
} from "./page-visibility";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function setFocused(focused: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

afterEach(() => {
  vi.restoreAllMocks();
  setVisibility("visible");
});

describe("getPageVisibility", () => {
  it("reports hidden when the document is not visible", () => {
    setVisibility("hidden");
    expect(getPageVisibility()).toEqual({ visible: false, focused: false });
  });

  it("reports visible but unfocused when on-screen without focus", () => {
    setVisibility("visible");
    setFocused(false);
    expect(getPageVisibility()).toEqual({ visible: true, focused: false });
  });

  it("reports focused when visible and focused", () => {
    setVisibility("visible");
    setFocused(true);
    expect(getPageVisibility()).toEqual({ visible: true, focused: true });
  });
});

describe("getVisibilityHeaderValue", () => {
  it("maps states to non-authoritative header hints", () => {
    expect(getVisibilityHeaderValue({ visible: false, focused: false })).toBe("hidden");
    expect(getVisibilityHeaderValue({ visible: true, focused: false })).toBe("visible");
    expect(getVisibilityHeaderValue({ visible: true, focused: true })).toBe("focused");
  });
});

describe("subscribePageVisibility", () => {
  it("notifies subscribers on visibility transitions and cleans up", () => {
    setVisibility("visible");
    setFocused(true);
    const listener = vi.fn();
    const unsubscribe = subscribePageVisibility(listener);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when the state is unchanged", () => {
    setVisibility("visible");
    setFocused(true);
    const listener = vi.fn();
    const unsubscribe = subscribePageVisibility(listener);
    // Same state → no notification.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
