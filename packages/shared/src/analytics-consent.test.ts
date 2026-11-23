import { describe, expect, it } from "vitest";
import { countryRequiresAnalyticsConsent, timeZoneRequiresAnalyticsConsent } from "./analytics-consent.js";

describe("countryRequiresAnalyticsConsent", () => {
  it.each(["DE", "fr", " GB ", "CH", "NO", "IS", "LI", "SJ", "RE", "JE", "UK", "uk", "EL", "GR", "EU", "EZ"])("requires consent for %s", (country) => {
    expect(countryRequiresAnalyticsConsent(country)).toBe(true);
  });

  it.each(["US", "CA", "JP", "BR", "TR", "UA"])("does not require consent for %s", (country) => {
    expect(countryRequiresAnalyticsConsent(country)).toBe(false);
  });

  it.each([null, undefined, "", "XX", "ZZ", "QQ", "AA", "UN", "QO", "XA", "XB", "XK", "T1", "DEU", "U"])("cannot tell for %s", (country) => {
    expect(countryRequiresAnalyticsConsent(country)).toBeNull();
  });
});

describe("timeZoneRequiresAnalyticsConsent", () => {
  it.each([
    "Europe/Berlin",
    "Europe/London",
    "Europe/Zurich",
    "Atlantic/Canary",
    "Atlantic/Reykjavik",
    "Arctic/Longyearbyen",
    "Asia/Nicosia",
    "Indian/Reunion",
    "UTC",
    "Etc/GMT+1",
    "",
    null,
    undefined,
  ])("requires consent for %s", (zone) => {
    expect(timeZoneRequiresAnalyticsConsent(zone)).toBe(true);
  });

  it.each(["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney", "America/Sao_Paulo"])(
    "does not require consent for %s",
    (zone) => {
      expect(timeZoneRequiresAnalyticsConsent(zone)).toBe(false);
    },
  );
});
