// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDefinition } from "@paperclipai/shared";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { isOneClickOAuthApp, releaseOneClickPopup, reserveOneClickPopup, takeOneClickPopup } from "./one-click-oauth";

function fakeWindow() {
  return { closed: false, opener: {}, close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }) } as unknown as Window & { close: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  releaseOneClickPopup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isOneClickOAuthApp", () => {
  it("accepts a connector with one automatic sign-in method", () => {
    expect(isOneClickOAuthApp(getAppStoreDefinition("notion") as AppDefinition)).toBe(true);
  });

  it("keeps the confirmation screen for connectors with warnings or choices", () => {
    expect(isOneClickOAuthApp(getAppStoreDefinition("github") as AppDefinition)).toBe(false);
    expect(isOneClickOAuthApp(getAppStoreDefinition("daytona") as AppDefinition)).toBe(false);
    expect(isOneClickOAuthApp(null)).toBe(false);
  });
});

describe("one-click sign-in window", () => {
  it("hands the reserved window to the flow once and cuts its opener", () => {
    const popup = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(popup);
    expect(reserveOneClickPopup()).toBe(true);
    expect(popup.opener).toBeNull();
    expect(takeOneClickPopup()).toBe(popup);
    expect(takeOneClickPopup()).toBeNull();
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("reports a blocked window so the caller keeps the confirmation screen", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(reserveOneClickPopup()).toBe(false);
    expect(takeOneClickPopup()).toBeNull();
  });

  it("closes a window no flow claimed", () => {
    vi.useFakeTimers();
    const popup = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(popup);
    reserveOneClickPopup();
    vi.advanceTimersByTime(15_000);
    expect(popup.close).toHaveBeenCalledOnce();
    expect(takeOneClickPopup()).toBeNull();
  });
});
