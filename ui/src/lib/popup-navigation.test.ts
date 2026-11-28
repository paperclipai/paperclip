// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { focusPopupWindow, navigatePopupWindow } from "./popup-navigation";

describe("navigatePopupWindow", () => {
  it("calls location.assign and returns the popup handle when available", () => {
    const assign = vi.fn();
    const popup = {
      closed: false,
      location: { assign, href: "" },
    } as unknown as Window;

    const result = navigatePopupWindow(popup, "https://example.com/auth");
    expect(assign).toHaveBeenCalledWith("https://example.com/auth");
    expect(result).toBe(popup);
  });

  it("falls back to location.href and returns the popup handle when location.assign throws SecurityError", () => {
    const popup = {
      closed: false,
      location: {
        get assign() {
          throw new DOMException("Failed to read a named property 'assign' from 'Location'", "SecurityError");
        },
        href: "",
      },
    } as unknown as Window;

    let result: Window | null = null;
    expect(() => {
      result = navigatePopupWindow(popup, "https://github.com/login/oauth/authorize");
    }).not.toThrow();

    expect(popup.location.href).toBe("https://github.com/login/oauth/authorize");
    expect(result).toBe(popup);
  });

  it("falls back to location.href and returns the popup handle when location.assign is undefined", () => {
    const popup = {
      closed: false,
      location: {
        href: "",
      },
    } as unknown as Window;

    let result: Window | null = null;
    expect(() => {
      result = navigatePopupWindow(popup, "https://example.com/callback");
    }).not.toThrow();

    expect(popup.location.href).toBe("https://example.com/callback");
    expect(result).toBe(popup);
  });

  it("returns null when popup is null, undefined, or closed", () => {
    expect(navigatePopupWindow(null, "https://example.com")).toBeNull();
    expect(navigatePopupWindow(undefined, "https://example.com")).toBeNull();
    expect(navigatePopupWindow({ closed: true } as Window, "https://example.com")).toBeNull();
  });

  it("falls back to window.open, returns the opened window handle, closes a superseded popup, and handles cross-origin name reads", () => {
    const close = vi.fn();
    const popup = {
      closed: false,
      name: "oauth-popup",
      close,
      get location() {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    } as unknown as Window;

    const reopened = { closed: false } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(reopened);
    expect(navigatePopupWindow(popup, "https://example.com/auth")).toBe(reopened);
    expect(openSpy).toHaveBeenCalledWith("https://example.com/auth", "oauth-popup");
    expect(close).toHaveBeenCalledTimes(1);

    const sameWindowPopup = {
      closed: false,
      name: "oauth-popup",
      close: vi.fn(),
      get location() {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    } as unknown as Window;
    openSpy.mockReturnValue(sameWindowPopup);
    expect(navigatePopupWindow(sameWindowPopup, "https://example.com/auth")).toBe(sameWindowPopup);
    expect(sameWindowPopup.close).not.toHaveBeenCalled();

    const crossOriginPopup = {
      closed: false,
      close: vi.fn(),
      get name() {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
      get location() {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    } as unknown as Window;
    openSpy.mockReturnValue(reopened);
    expect(navigatePopupWindow(crossOriginPopup, "https://example.com/auth")).toBe(reopened);
    expect(openSpy).toHaveBeenCalledWith("https://example.com/auth", "");
    expect(crossOriginPopup.close).toHaveBeenCalledTimes(1);

    openSpy.mockReturnValue(null);
    expect(navigatePopupWindow(popup, "https://example.com/auth")).toBeNull();
    openSpy.mockRestore();
  });
});

describe("focusPopupWindow", () => {
  it("calls popup.focus when available", () => {
    const focus = vi.fn();
    const popup = { focus } as unknown as Window;

    focusPopupWindow(popup);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not throw when focus throws cross-origin error", () => {
    const popup = {
      focus: () => {
        throw new DOMException("Blocked a frame with origin from accessing a cross-origin frame", "SecurityError");
      },
    } as unknown as Window;

    expect(() => focusPopupWindow(popup)).not.toThrow();
  });
});
