import { describe, expect, it } from "vitest";
import { parseProviderQuotaClockReset } from "./provider-quota-reset.js";

const weeklyLimit = "ACP agent reported a terminal limit failure.\nYou've hit your weekly limit · resets Nov 10, 3pm (UTC)";

describe("parseProviderQuotaClockReset", () => {
  it("reads a dated reset as that day, not as an unparsed limit", () => {
    expect(parseProviderQuotaClockReset(weeklyLimit, new Date("2026-11-07T00:50:37Z")))
      .toEqual(new Date("2026-11-10T15:00:00Z"));
  });

  it.each([
    ["resets Nov 10 at 3:30pm (UTC)", "2026-11-10T15:30:00Z"],
    ["resets November 10, 3 PM UTC", "2026-11-10T15:00:00Z"],
    ["resets Dec. 1, 9am (UTC)", "2026-12-01T09:00:00Z"],
    ["resets Nov 10th, 2026 3pm", "2026-11-10T15:00:00Z"],
    ["try again at Nov 10th, 2026 2:04 AM.", "2026-11-10T02:04:00Z"],
    ["resets Nov 10, 15:00 (UTC)", "2026-11-10T15:00:00Z"],
    ["resets Nov 10, 3pm (America/Chicago)", "2026-11-10T21:00:00Z"],
  ])("reads %s", (wording, expected) => {
    expect(parseProviderQuotaClockReset(`You've hit your weekly limit · ${wording}`, new Date("2026-11-07T00:50:37Z")))
      .toEqual(new Date(expected));
  });

  it("rolls a dated reset without a year into the next year at the year boundary", () => {
    expect(parseProviderQuotaClockReset("resets Jan 2, 3pm (UTC)", new Date("2026-12-30T12:00:00Z")))
      .toEqual(new Date("2027-01-02T15:00:00Z"));
  });

  it("keeps a recently passed dated reset in the past instead of a year later", () => {
    expect(parseProviderQuotaClockReset("resets Nov 6, 3pm (UTC)", new Date("2026-11-07T00:50:37Z")))
      .toEqual(new Date("2026-11-06T15:00:00Z"));
  });

  it("does not read a dated reset that is far from the current allowance period", () => {
    const now = new Date("2026-11-07T00:50:37Z");
    expect(parseProviderQuotaClockReset("resets Sept 1, 9am (UTC)", now)).toBeNull();
    expect(parseProviderQuotaClockReset("resets Nov 10, 2027 3pm (UTC)", now)).toBeNull();
  });

  it.each([
    "resets Apr 31, 3pm (UTC)",
    "resets Feb 29, 2027 3pm (UTC)",
    "resets Nov 0, 3pm (UTC)",
    "resets Nov 10, 13pm (UTC)",
    "resets Nov 10, 3:60pm (UTC)",
    "resets Novembork 10, 3pm (UTC)",
    "resets Nov 10, 3pm (Not/AZone)",
  ])("rejects the invalid dated reset %s", (wording) => {
    expect(parseProviderQuotaClockReset(wording, new Date("2026-11-07T00:50:37Z"))).toBeNull();
  });

  it("keeps clock-only resets on the next matching wall clock", () => {
    const now = new Date("2026-11-07T00:50:37Z");
    expect(parseProviderQuotaClockReset("You've hit your session limit · resets 2am (UTC)", now))
      .toEqual(new Date("2026-11-07T02:00:00Z"));
    expect(parseProviderQuotaClockReset("try again at 4:30 PM (America/Chicago)", now))
      .toEqual(new Date("2026-11-07T22:30:00Z"));
    expect(parseProviderQuotaClockReset("resets 12am", now)).toEqual(new Date("2026-11-08T00:00:00Z"));
  });

  it("returns null when no reset is stated", () => {
    expect(parseProviderQuotaClockReset("ACP agent reported a terminal limit failure.", new Date())).toBeNull();
  });
});
