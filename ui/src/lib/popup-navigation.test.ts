import { describe, expect, it, vi } from "vitest";
import { focusPopupWindow, navigatePopupWindow } from "./popup-navigation";

describe("navigatePopupWindow", () => {
  it("calls location.assign when available", () => {
    const assign = vi.fn();
    const popup = {
      closed: false,
      location: { assign, href: "" },
    } as unknown as Window;

    navigatePopupWindow(popup, "https://example.com/auth");
    expect(assign).toHaveBeenCalledWith("https://example.com/auth");
  });

  it("falls back to location.href when location.assign throws SecurityError", () => {
    const popup = {
      closed: false,
      location: {
        get assign() {
          throw new DOMException("Failed to read a named property 'assign' from 'Location'", "SecurityError");
        },
        href: "",
      },
    } as unknown as Window;

    expect(() => {
      navigatePopupWindow(popup, "https://github.com/login/oauth/authorize");
    }).not.toThrow();

    expect(popup.location.href).toBe("https://github.com/login/oauth/authorize");
  });

  it("falls back to location.href when location.assign is undefined", () => {
    const popup = {
      closed: false,
      location: {
        href: "",
      },
    } as unknown as Window;

    expect(() => {
      navigatePopupWindow(popup, "https://example.com/callback");
    }).not.toThrow();

    expect(popup.location.href).toBe("https://example.com/callback");
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
