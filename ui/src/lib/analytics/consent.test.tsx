// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAnalyticsConfig } from "@paperclipai/shared";
import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  resetAnalyticsConsentForTest,
  resolveAnalyticsConsent,
  storeAnalyticsChoice,
  useAnalyticsConsent,
} from "./consent";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const config: BrowserAnalyticsConfig = {
  token: "phc_test",
  apiHost: "/_ph",
  uiHost: null,
  environment: "production",
  stackId: "stack-1",
  replayEnabled: true,
};

function useTimeZone(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions(),
    timeZone,
  });
}

function setNavigatorSignal(name: "doNotTrack" | "globalPrivacyControl", value: unknown) {
  Object.defineProperty(navigator, name, { value, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetAnalyticsConsentForTest();
  setNavigatorSignal("doNotTrack", null);
  setNavigatorSignal("globalPrivacyControl", undefined);
});

describe("resolveAnalyticsConsent", () => {
  it("uses the server's decision when it has one", () => {
    useTimeZone("Europe/Paris");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: false })).toBe("granted");
    useTimeZone("America/Chicago");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("ask");
  });

  it("falls back to the browser time zone when the server cannot tell", () => {
    useTimeZone("Europe/Paris");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: null })).toBe("ask");
    useTimeZone("America/Chicago");
    expect(resolveAnalyticsConsent(config)).toBe("granted");
  });

  it("requires consent when the browser time zone cannot be read", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("no Intl");
    });
    expect(resolveAnalyticsConsent(config)).toBe("ask");
  });

  it("treats Do Not Track and Global Privacy Control as a decline only where consent is required", () => {
    setNavigatorSignal("doNotTrack", "1");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("denied");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: false })).toBe("granted");
    setNavigatorSignal("doNotTrack", null);
    setNavigatorSignal("globalPrivacyControl", true);
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("denied");
  });

  it("a stored choice wins over the region default", () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("granted");
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "denied");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: false })).toBe("denied");
  });

  it("lets Global Privacy Control and Do Not Track win over a stored grant where consent is required", () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    setNavigatorSignal("globalPrivacyControl", true);
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("denied");
    storeAnalyticsChoice("granted");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("denied");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: false })).toBe("granted");
    setNavigatorSignal("globalPrivacyControl", undefined);
    setNavigatorSignal("doNotTrack", "1");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("denied");
  });

  it("keeps the choice for this page when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("ask");
    storeAnalyticsChoice("granted");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("granted");
  });

  it("lets the latest choice on this page win when saving fails but reading still works", () => {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    storeAnalyticsChoice("denied");
    expect(window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe("granted");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: false })).toBe("denied");
  });

  it("follows a choice that another tab changes", () => {
    const seen: string[] = [];
    const container = document.createElement("div");
    function Probe() {
      seen.push(String(useAnalyticsConsent({ ...config, consentRequired: true })));
      return null;
    }
    const root = createRoot(container);
    act(() => root.render(<Probe />));
    act(() => storeAnalyticsChoice("granted"));
    act(() => {
      window.localStorage.removeItem(ANALYTICS_CONSENT_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: ANALYTICS_CONSENT_STORAGE_KEY }));
    });
    expect(seen.at(-1)).toBe("ask");
    act(() => root.unmount());
  });
});
