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
