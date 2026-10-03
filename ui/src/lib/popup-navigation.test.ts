// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { focusPopupWindow, navigatePopupWindow } from "./popup-navigation";

describe("navigatePopupWindow", () => {
  it("calls location.assign and returns true when available", () => {
    const assign = vi.fn();
    const popup = {
      closed: false,
      location: { assign, href: "" },
    } as unknown as Window;

    const result = navigatePopupWindow(popup, "https://example.com/auth");
    expect(assign).toHaveBeenCalledWith("https://example.com/auth");
    expect(result).toBe(true);
  });

  it("falls back to location.href and returns true when location.assign throws SecurityError", () => {
    const popup = {
      closed: false,
      location: {
        get assign() {
          throw new DOMException("Failed to read a named property 'assign' from 'Location'", "SecurityError");
        },
        href: "",
      },
    } as unknown as Window;

    let result = false;
    expect(() => {
      result = navigatePopupWindow(popup, "https://github.com/login/oauth/authorize");
    }).not.toThrow();

    expect(popup.location.href).toBe("https://github.com/login/oauth/authorize");
    expect(result).toBe(true);
  });

  it("falls back to location.href and returns true when location.assign is undefined", () => {
    const popup = {
      closed: false,
      location: {
        href: "",
      },
    } as unknown as Window;

    let result = false;
    expect(() => {
      result = navigatePopupWindow(popup, "https://example.com/callback");
    }).not.toThrow();

    expect(popup.location.href).toBe("https://example.com/callback");
    expect(result).toBe(true);
  });

  it("returns false when popup is null, undefined, or closed", () => {
    expect(navigatePopupWindow(null, "https://example.com")).toBe(false);
    expect(navigatePopupWindow(undefined, "https://example.com")).toBe(false);
    expect(navigatePopupWindow({ closed: true } as Window, "https://example.com")).toBe(false);
  });

  it("falls back to window.open and returns its boolean success if setting location fails", () => {
    const popup = {
      closed: false,
      name: "oauth-popup",
      get location() {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    } as unknown as Window;

    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
    expect(navigatePopupWindow(popup, "https://example.com/auth")).toBe(true);
    expect(openSpy).toHaveBeenCalledWith("https://example.com/auth", "oauth-popup");

    openSpy.mockReturnValue(null);
    expect(navigatePopupWindow(popup, "https://example.com/auth")).toBe(false);
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
