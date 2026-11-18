// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAnalyticsConfig } from "@paperclipai/shared";
import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  resetAnalyticsConsentForTest,
  resolveAnalyticsConsent,
  storeAnalyticsChoice,
  timeZoneRequiresConsent,
} from "./consent";

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

describe("timeZoneRequiresConsent", () => {
  it.each([
    "Europe/Berlin",
    "Europe/London",
    "Europe/Zurich",
    "Europe/Dublin",
    "Atlantic/Canary",
    "Atlantic/Reykjavik",
    "Asia/Nicosia",
    "Indian/Reunion",
    "UTC",
    "Etc/GMT+1",
    "",
  ])("requires consent for %s", (zone) => {
    expect(timeZoneRequiresConsent(zone)).toBe(true);
  });

  it.each(["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney", "America/Sao_Paulo"])(
    "does not require consent for %s",
    (zone) => {
      expect(timeZoneRequiresConsent(zone)).toBe(false);
    },
  );

  it("requires consent when the time zone is unknown", () => {
    expect(timeZoneRequiresConsent(null)).toBe(true);
    expect(timeZoneRequiresConsent(undefined)).toBe(true);
  });
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

  it("a stored choice wins over the region default and the browser signals", () => {
    setNavigatorSignal("globalPrivacyControl", true);
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "granted");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: true })).toBe("granted");
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "denied");
    expect(resolveAnalyticsConsent({ ...config, consentRequired: false })).toBe("denied");
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
});
