// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUBMIT_KEY_STORAGE_KEY,
  getSubmitKeyPreference,
  isSubmitKeyEvent,
  setSubmitKeyPreference,
  submitShortcutLabel,
  subscribeSubmitKeyPreference,
} from "./submitKeyPreference";

function key(overrides: Partial<Parameters<typeof isSubmitKeyEvent>[0]> = {}) {
  return { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...overrides };
}

describe("isSubmitKeyEvent", () => {
  it('"enter" mode: plain Return submits, Shift/Alt+Return do not', () => {
    expect(isSubmitKeyEvent(key(), "enter")).toBe(true);
    expect(isSubmitKeyEvent(key({ shiftKey: true }), "enter")).toBe(false);
    expect(isSubmitKeyEvent(key({ altKey: true }), "enter")).toBe(false);
  });

  it('"enter" mode: Cmd/Ctrl+Return still submits', () => {
    expect(isSubmitKeyEvent(key({ metaKey: true }), "enter")).toBe(true);
    expect(isSubmitKeyEvent(key({ ctrlKey: true }), "enter")).toBe(true);
  });

  it('"mod-enter" mode: only Cmd/Ctrl+Return submits', () => {
    expect(isSubmitKeyEvent(key(), "mod-enter")).toBe(false);
    expect(isSubmitKeyEvent(key({ shiftKey: true }), "mod-enter")).toBe(false);
    expect(isSubmitKeyEvent(key({ metaKey: true }), "mod-enter")).toBe(true);
    expect(isSubmitKeyEvent(key({ ctrlKey: true }), "mod-enter")).toBe(true);
  });

  it("ignores other keys", () => {
    expect(isSubmitKeyEvent(key({ key: "a" }), "enter")).toBe(false);
    expect(isSubmitKeyEvent(key({ key: "a", metaKey: true }), "mod-enter")).toBe(false);
  });

  it("never submits during IME composition", () => {
    for (const mode of ["enter", "mod-enter"] as const) {
      expect(isSubmitKeyEvent(key({ isComposing: true, metaKey: true }), mode)).toBe(false);
      expect(isSubmitKeyEvent(key({ nativeEvent: { isComposing: true } }), mode)).toBe(false);
      expect(isSubmitKeyEvent(key({ keyCode: 229, ctrlKey: true }), mode)).toBe(false);
    }
  });
});

describe("submitShortcutLabel", () => {
  it("names the platform modifier", () => {
    expect(submitShortcutLabel("enter", true)).toBe("Return");
    expect(submitShortcutLabel("mod-enter", true)).toBe("⌘Return");
    expect(submitShortcutLabel("mod-enter", false)).toBe("Ctrl+Return");
  });
});

describe("submit key preference store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is unset by default and ignores unknown stored values", () => {
    expect(getSubmitKeyPreference()).toBeNull();
    window.localStorage.setItem(SUBMIT_KEY_STORAGE_KEY, "shift-enter");
    expect(getSubmitKeyPreference()).toBeNull();
  });

  it("round-trips the chosen mode through localStorage", () => {
    setSubmitKeyPreference("enter");
    expect(window.localStorage.getItem(SUBMIT_KEY_STORAGE_KEY)).toBe("enter");
    expect(getSubmitKeyPreference()).toBe("enter");
    setSubmitKeyPreference("mod-enter");
    expect(getSubmitKeyPreference()).toBe("mod-enter");
  });

  it("notifies same-tab subscribers and other-tab storage events", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSubmitKeyPreference(listener);
    setSubmitKeyPreference("enter");
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key: SUBMIT_KEY_STORAGE_KEY }));
    expect(listener).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setSubmitKeyPreference("mod-enter");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tolerates a throwing localStorage and keeps the choice in memory", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setSubmitKeyPreference("enter")).not.toThrow();
    expect(getSubmitKeyPreference()).toBe("enter");
  });
});
