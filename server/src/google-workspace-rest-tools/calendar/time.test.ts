import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  formatInZone,
  instantOf,
  isValidTimeZone,
  offsetMinutesAt,
  parseTimeInput,
  zonedToInstant,
} from "./time.js";

const at = (iso: string) => Date.parse(iso);

describe("parseTimeInput", () => {
  it.each([
    ["2026-04-30", { date: { year: 2026, month: 4, day: 30 }, time: null, offsetMinutes: null }],
    ["2026-04-30T10:00", { date: { year: 2026, month: 4, day: 30 }, time: { hour: 10, minute: 0, second: 0, millisecond: 0 }, offsetMinutes: null }],
    ["2026-04-30T10:00:05.25", { date: { year: 2026, month: 4, day: 30 }, time: { hour: 10, minute: 0, second: 5, millisecond: 250 }, offsetMinutes: null }],
    ["2026-04-30T10:00:00Z", { date: { year: 2026, month: 4, day: 30 }, time: { hour: 10, minute: 0, second: 0, millisecond: 0 }, offsetMinutes: 0 }],
    ["2026-04-30T10:00:00-07:00", { date: { year: 2026, month: 4, day: 30 }, time: { hour: 10, minute: 0, second: 0, millisecond: 0 }, offsetMinutes: -420 }],
    ["2026-04-30T10:00:00+0530", { date: { year: 2026, month: 4, day: 30 }, time: { hour: 10, minute: 0, second: 0, millisecond: 0 }, offsetMinutes: 330 }],
    ["2028-02-29T00:00:00", { date: { year: 2028, month: 2, day: 29 }, time: { hour: 0, minute: 0, second: 0, millisecond: 0 }, offsetMinutes: null }],
  ])("reads %s", (value, expected) => {
    expect(parseTimeInput(value)).toEqual(expected);
  });

  it.each(["2026-02-29", "2026-13-01", "2026-04-31T10:00", "2026-04-30T24:00:00", "2026-04-30T10:60", "2026-04-30Z", "2026-04-30+01:00", "tomorrow", "30/04/2026", ""])(
    "rejects %j",
    (value) => {
      expect(() => parseTimeInput(value, "startTime")).toThrow(/startTime must be an ISO 8601/);
    },
  );
});

describe("zonedToInstant across time zones and DST", () => {
  it.each([
    ["New York, winter", "America/New_York", "2026-01-15T09:00:00", "2026-01-15T14:00:00Z"],
    ["New York, summer", "America/New_York", "2026-07-15T09:00:00", "2026-07-15T13:00:00Z"],
    ["New York, the hour that does not exist (spring forward) moves forward", "America/New_York", "2026-03-08T02:30:00", "2026-03-08T07:30:00Z"],
    ["New York, just after spring forward", "America/New_York", "2026-03-08T03:00:00", "2026-03-08T07:00:00Z"],
    ["New York, the repeated hour (fall back) takes the first occurrence", "America/New_York", "2026-11-01T01:30:00", "2026-11-01T05:30:00Z"],
    ["New York, after fall back", "America/New_York", "2026-11-01T02:00:00", "2026-11-01T07:00:00Z"],
    ["London, the missing hour", "Europe/London", "2026-03-29T01:30:00", "2026-03-29T01:30:00Z"],
    ["London, the repeated hour", "Europe/London", "2026-10-25T01:30:00", "2026-10-25T00:30:00Z"],
    ["Lord Howe, a 30-minute DST gap", "Australia/Lord_Howe", "2026-10-04T02:15:00", "2026-10-03T15:45:00Z"],
    ["Sydney, southern summer", "Australia/Sydney", "2026-01-15T09:00:00", "2026-01-14T22:00:00Z"],
    ["Kolkata, half-hour offset", "Asia/Kolkata", "2026-06-01T09:00:00", "2026-06-01T03:30:00Z"],
    ["UTC", "UTC", "2026-06-01T09:00:00", "2026-06-01T09:00:00Z"],
  ])("%s", (_name, timeZone, local, expected) => {
    const input = parseTimeInput(local);
    expect(new Date(zonedToInstant(input.date, input.time!, timeZone)).toISOString()).toBe(new Date(expected).toISOString());
  });
});

describe("instantOf", () => {
  it("uses the input's own offset over the time zone", () => {
    expect(instantOf(parseTimeInput("2026-04-30T10:00:00-07:00"), "Asia/Tokyo")).toBe(at("2026-04-30T17:00:00Z"));
  });

  it("reads a date alone as local midnight", () => {
    expect(instantOf(parseTimeInput("2026-04-30"), "Europe/Berlin")).toBe(at("2026-04-29T22:00:00Z"));
  });

  it("never guesses a time zone", () => {
    expect(() => instantOf(parseTimeInput("2026-04-30T10:00:00"), undefined)).toThrow(/time zone is needed/);
  });
});

describe("formatInZone", () => {
  it.each([
    ["2026-03-08T07:30:00Z", "America/New_York", "2026-03-08T03:30:00-04:00"],
    ["2026-03-08T06:59:00Z", "America/New_York", "2026-03-08T01:59:00-05:00"],
    ["2026-01-10T12:00:00Z", "Europe/London", "2026-01-10T12:00:00Z"],
    ["2026-06-01T03:30:00Z", "Asia/Kolkata", "2026-06-01T09:00:00+05:30"],
    ["2026-10-03T15:45:00Z", "Australia/Lord_Howe", "2026-10-04T02:45:00+11:00"],
    ["2026-11-17T15:00:00.100Z", "UTC", "2026-11-17T15:00:00.100Z"],
    ["1969-12-31T23:59:59.900Z", "UTC", "1969-12-31T23:59:59.900Z"],
  ])("formats %s in %s", (instant, timeZone, expected) => {
    expect(formatInZone(at(instant), timeZone)).toBe(expected);
  });

  it("round-trips through zonedToInstant", () => {
    const instant = at("2026-11-01T06:30:00Z");
    expect(instantOf(parseTimeInput(formatInZone(instant, "America/New_York")), undefined)).toBe(instant);
  });
});

describe("addLocalDays", () => {
  it("keeps the wall-clock time across a DST change", () => {
    const before = at("2026-03-07T17:00:00Z");
    const after = addLocalDays(before, 1, "America/New_York");
    expect(formatInZone(after, "America/New_York")).toBe("2026-03-08T12:00:00-04:00");
    expect(after - before).toBe(23 * 3_600_000);
  });
});

describe("time zone names", () => {
  it.each([["America/Los_Angeles", true], ["UTC", true], ["Etc/GMT+5", true], ["Mars/Olympus", false], ["+05:00", false], ["", false], ["PST8PDT ", false]])(
    "%j valid: %s",
    (value, valid) => {
      expect(isValidTimeZone(value)).toBe(valid);
    },
  );

  it("reports the offset in force at an instant", () => {
    expect(offsetMinutesAt(at("2026-07-01T00:00:00Z"), "America/New_York")).toBe(-240);
    expect(offsetMinutesAt(at("2026-12-01T00:00:00Z"), "America/New_York")).toBe(-300);
  });
});
