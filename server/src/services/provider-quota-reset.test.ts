import { describe, expect, it } from "vitest";
import { parseProviderQuotaClockReset } from "./provider-quota-reset.js";

describe("parseProviderQuotaClockReset", () => {
  it("reads a weekly limit's calendar reset, as Claude's ACP agent reports it", () => {
    // Staging run c086fa26 (PAP-1057), 2026-11-10: the reset is two days out.
    const now = new Date("2026-11-10T20:06:33.000Z");
    const message = "ACP agent reported a terminal limit failure.\nYou've hit your weekly limit · resets Nov 12, 6pm (UTC)";
    expect(parseProviderQuotaClockReset(message, now)).toEqual(new Date("2026-11-12T18:00:00.000Z"));
  });

  it("reads a calendar reset in a named time zone, with minutes and an ordinal", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(parseProviderQuotaClockReset("resets Jul 17th at 4:30 PM (America/Chicago)", now))
      .toEqual(new Date("2026-07-17T21:30:00.000Z"));
    expect(parseProviderQuotaClockReset("Resets on August 2, 9am (UTC)", now))
      .toEqual(new Date("2026-08-02T09:00:00.000Z"));
  });

  it("rolls a calendar reset that already passed into next year, and rejects impossible dates", () => {
    expect(parseProviderQuotaClockReset("resets Jan 2, 6pm (UTC)", new Date("2026-12-30T10:00:00.000Z")))
      .toEqual(new Date("2027-01-02T18:00:00.000Z"));
    expect(parseProviderQuotaClockReset("resets Nov 31, 6pm (UTC)", new Date("2026-11-10T10:00:00.000Z"))).toBeNull();
  });

  it("reads a calendar reset that already passed as expired, never as a year away", () => {
    // Recovery rereads an unchanged failure days after its reset.
    expect(parseProviderQuotaClockReset("resets Nov 12, 6pm (UTC)", new Date("2026-11-14T10:00:00.000Z")))
      .toEqual(new Date("2026-11-12T18:00:00.000Z"));
    expect(parseProviderQuotaClockReset("resets Dec 30, 6pm (UTC)", new Date("2027-01-03T10:00:00.000Z")))
      .toEqual(new Date("2026-12-30T18:00:00.000Z"));
  });

  it("keeps reading a clock-only reset as the next matching time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(parseProviderQuotaClockReset("You've hit your session limit · resets 2am (UTC)", now))
      .toEqual(new Date("2026-07-16T02:00:00.000Z"));
    expect(parseProviderQuotaClockReset("Try again at 4:30 PM (America/Chicago).", now))
      .toEqual(new Date("2026-07-15T21:30:00.000Z"));
    expect(parseProviderQuotaClockReset("resets 9pm", now)).toEqual(new Date("2026-07-15T21:00:00.000Z"));
    expect(parseProviderQuotaClockReset("Provider quota exceeded for this model.", now)).toBeNull();
  });
});

const weeklyLimit = "ACP agent reported a terminal limit failure.\nYou've hit your weekly limit · resets Nov 10, 3pm (UTC)";

describe("dated provider quota reset compatibility", () => {
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

  it("keeps stale calendar dates expired and rejects a far-future explicit year", () => {
    const now = new Date("2026-11-07T00:50:37Z");
    expect(parseProviderQuotaClockReset("resets Sept 1, 9am (UTC)", now)).toEqual(new Date("2026-09-01T09:00:00Z"));
    expect(parseProviderQuotaClockReset("resets Nov 10, 2027 3pm (UTC)", now)).toBeNull();
  });

  it.each([
    "resets Apr 31, 3pm (UTC)",
    "resets Feb 29, 2027 3pm (UTC)",
    "resets Nov 10, 2026",
    "resets Nov 10, 2026 25pm (UTC)",
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
