import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import {
  allowedWindows,
  busyFromEvents,
  busyFromFreeBusy,
  freeBusyRequest,
  freeIntervals,
  mergeIntervals,
  suggestRange,
  suggestSlots,
  suggestTime,
  type Interval,
} from "./suggest-time.js";

const at = (value: string) => Date.parse(value);
const span = (start: string, end: string): Interval => ({ start: at(start), end: at(end) });
const show = (intervals: Interval[]) => intervals.map((item) => `${new Date(item.start).toISOString()}/${new Date(item.end).toISOString()}`);

describe("interval arithmetic", () => {
  it("merges overlapping and touching busy times", () => {
    expect(show(mergeIntervals([
      span("2026-11-17T10:00:00Z", "2026-11-17T11:00:00Z"),
      span("2026-11-17T09:00:00Z", "2026-11-17T10:30:00Z"),
      span("2026-11-17T11:00:00Z", "2026-11-17T11:15:00Z"),
      span("2026-11-17T13:00:00Z", "2026-11-17T13:00:00Z"),
    ]))).toEqual(["2026-11-17T09:00:00.000Z/2026-11-17T11:15:00.000Z"]);
  });

  it("finds the gaps between busy times inside the range", () => {
    expect(show(freeIntervals(span("2026-11-17T08:00:00Z", "2026-11-17T18:00:00Z"), [
      span("2026-11-17T07:00:00Z", "2026-11-17T09:00:00Z"),
      span("2026-11-17T12:00:00Z", "2026-11-17T13:00:00Z"),
      span("2026-11-17T17:30:00Z", "2026-11-17T19:00:00Z"),
    ]))).toEqual([
      "2026-11-17T09:00:00.000Z/2026-11-17T12:00:00.000Z",
      "2026-11-17T13:00:00.000Z/2026-11-17T17:30:00.000Z",
    ]);
  });
});

describe("allowed daily windows", () => {
  it.each([
    ["no preferences: the whole range", span("2026-11-16T00:00:00Z", "2026-11-18T00:00:00Z"), "UTC", {}, [
      "2026-11-16T00:00:00.000Z/2026-11-18T00:00:00.000Z",
    ]],
    ["working hours in New York", span("2026-11-16T05:00:00Z", "2026-11-18T05:00:00Z"), "America/New_York", { startHour: "09:00", endHour: "17:00" }, [
      "2026-11-16T14:00:00.000Z/2026-11-16T22:00:00.000Z",
      "2026-11-17T14:00:00.000Z/2026-11-17T22:00:00.000Z",
    ]],
    ["working hours keep local time across the end of DST", span("2026-10-30T04:00:00Z", "2026-11-03T05:00:00Z"), "America/New_York", { startHour: "09:00", endHour: "10:00", excludeWeekends: true }, [
      "2026-10-30T13:00:00.000Z/2026-10-30T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z/2026-11-02T15:00:00.000Z",
    ]],
    ["weekends left out; whole weekdays join across midnight", span("2026-11-19T00:00:00Z", "2026-11-24T00:00:00Z"), "UTC", { excludeWeekends: true }, [
      "2026-11-19T00:00:00.000Z/2026-11-21T00:00:00.000Z",
      "2026-11-23T00:00:00.000Z/2026-11-24T00:00:00.000Z",
    ]],
    ["24:00 means the end of the day", span("2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z"), "UTC", { startHour: "20:00", endHour: "24:00" }, [
      "2026-11-17T20:00:00.000Z/2026-11-18T00:00:00.000Z",
    ]],
  ])("%s", (_name, range, timeZone, preferences, expected) => {
    expect(show(allowedWindows(range, timeZone, preferences))).toEqual(expected);
  });

  it("refuses a window that ends before it starts", () => {
    expect(() => allowedWindows(span("2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z"), "UTC", { startHour: "18:00", endHour: "09:00" })).toThrow(/endHour/);
  });
});

describe("suggestSlots", () => {
  const range = span("2026-11-17T14:00:00Z", "2026-11-17T22:00:00Z");
  const busy = [span("2026-11-17T14:00:00Z", "2026-11-17T15:00:00Z"), span("2026-11-17T15:20:00Z", "2026-11-17T16:00:00Z"), span("2026-11-17T18:00:00Z", "2026-11-17T21:00:00Z")];

  it.each([
    ["default 30 minutes skips the 20-minute gap", {}, ["2026-11-17T16:00:00.000Z/2026-11-17T18:00:00.000Z", "2026-11-17T21:00:00.000Z/2026-11-17T22:00:00.000Z"]],
    ["15 minutes keeps it", { durationMinutes: 15 }, ["2026-11-17T15:00:00.000Z/2026-11-17T15:20:00.000Z", "2026-11-17T16:00:00.000Z/2026-11-17T18:00:00.000Z", "2026-11-17T21:00:00.000Z/2026-11-17T22:00:00.000Z"]],
    ["90 minutes leaves one", { durationMinutes: 90 }, ["2026-11-17T16:00:00.000Z/2026-11-17T18:00:00.000Z"]],
    ["pageSize limits the count", { durationMinutes: 15, preferences: { pageSize: 1 } }, ["2026-11-17T15:00:00.000Z/2026-11-17T15:20:00.000Z"]],
    ["hours trim the periods", { preferences: { startHour: "12:00", endHour: "16:30" } }, ["2026-11-17T17:00:00.000Z/2026-11-17T18:00:00.000Z", "2026-11-17T21:00:00.000Z/2026-11-17T21:30:00.000Z"]],
  ])("%s", (_name, input, expected) => {
    expect(show(suggestSlots(range, busy, "America/New_York", input))).toEqual(expected);
  });
});

describe("suggest_time range", () => {
  it("reads times in the time zone and limits the range", () => {
    const input = { attendeeEmails: ["a@example.test"], startTime: "2026-11-17T09:00:00", endTime: "2026-11-17T17:00:00" };
    expect(show([suggestRange(input, "America/Chicago")])).toEqual(["2026-11-17T15:00:00.000Z/2026-11-17T23:00:00.000Z"]);
    expect(() => suggestRange({ ...input, endTime: "2027-03-01T00:00:00" }, "UTC")).toThrow(/62 days/);
    expect(() => suggestRange({ ...input, endTime: "2026-11-17T08:00:00" }, "UTC")).toThrow(/after startTime/);
  });
});

describe("free/busy answers", () => {
  it("builds a read-only free/busy query", () => {
    expect(freeBusyRequest(["a@example.test", "b@example.test"], span("2026-11-17T14:00:00Z", "2026-11-17T22:00:00Z"), "America/New_York")).toEqual({
      method: "POST",
      readOnly: true,
      host: "www.googleapis.com",
      path: "/calendar/v3/freeBusy",
      body: {
        timeMin: "2026-11-17T14:00:00.000Z",
        timeMax: "2026-11-17T22:00:00.000Z",
        timeZone: "America/New_York",
        items: [{ id: "a@example.test" }, { id: "b@example.test" }],
      },
    });
  });

  it("collects every attendee's busy times, matching addresses case-insensitively", () => {
    expect(show(busyFromFreeBusy({
      calendars: {
        "a@example.test": { busy: [{ start: "2026-11-17T10:00:00-05:00", end: "2026-11-17T11:00:00-05:00" }] },
        "b@example.test": { busy: [] },
      },
    }, ["A@example.test", "b@example.test"]))).toEqual(["2026-11-17T15:00:00.000Z/2026-11-17T16:00:00.000Z"]);
  });

  it("refuses to suggest when an attendee's availability is unknown", () => {
    expect(() => busyFromFreeBusy({
      calendars: { "a@example.test": { busy: [] }, "x@other.test": { errors: [{ reason: "notFound" }] } },
    }, ["a@example.test", "x@other.test", "y@other.test"])).toThrow("Google could not share availability for: x@other.test, y@other.test.");
  });

  it("refuses a busy time it cannot read, on both paths, instead of treating it as free", () => {
    expect(() => busyFromFreeBusy({ calendars: { "a@example.test": { busy: [{ start: "soon", end: "2026-11-17T11:00:00Z" }] } } }, ["a@example.test"]))
      .toThrow(/could not be read/);
    expect(() => busyFromEvents([{ start: { dateTime: "2026-11-17T10:00:00Z" } }], "UTC")).toThrow(/could not be read/);
    expect(() => busyFromEvents([{ start: { date: "2026-02-30" }, end: { date: "2026-03-01" } }], "UTC")).toThrow(/could not be read/);
  });

  it("counts only events that block time when reading calendars directly", () => {
    expect(show(busyFromEvents([
      { status: "confirmed", start: { dateTime: "2026-11-17T10:00:00-05:00" }, end: { dateTime: "2026-11-17T11:00:00-05:00" } },
      { status: "cancelled", start: { dateTime: "2026-11-17T12:00:00-05:00" }, end: { dateTime: "2026-11-17T13:00:00-05:00" } },
      { transparency: "transparent", start: { dateTime: "2026-11-17T13:00:00-05:00" }, end: { dateTime: "2026-11-17T14:00:00-05:00" } },
      { attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-11-17T14:00:00-05:00" }, end: { dateTime: "2026-11-17T15:00:00-05:00" } },
      { start: { date: "2026-11-18" }, end: { date: "2026-11-19" } },
    ], "America/New_York"))).toEqual([
      "2026-11-17T15:00:00.000Z/2026-11-17T16:00:00.000Z",
      "2026-11-18T05:00:00.000Z/2026-11-19T05:00:00.000Z",
    ]);
  });
});

describe("suggest_time tool", () => {
  const input = {
    attendeeEmails: ["avery@example.test", "blake@example.test"],
    startTime: "2026-11-17T09:00:00",
    endTime: "2026-11-17T17:00:00",
    preferences: { pageSize: 2 },
  };

  it("uses the primary calendar's time zone, queries free/busy and formats slots in that zone", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/events")) return json({ timeZone: "America/New_York" });
      return json({
        calendars: {
          "avery@example.test": { busy: [{ start: "2026-11-17T14:00:00Z", end: "2026-11-17T15:00:00Z" }] },
          "blake@example.test": { busy: [{ start: "2026-11-17T15:30:00Z", end: "2026-11-17T16:00:00Z" }] },
        },
      });
    });
    const result = await suggestTime.call(input, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /calendar/v3/calendars/primary/events",
      "POST /calendar/v3/freeBusy",
    ]);
    expect(result.structuredContent).toEqual({
      timeSlots: [
        {
          startTime: "2026-11-17T10:00:00-05:00", endTime: "2026-11-17T10:30:00-05:00", durationMinutes: 30,
          start: { dateTime: "2026-11-17T10:00:00-05:00", timeZone: "America/New_York" },
          end: { dateTime: "2026-11-17T10:30:00-05:00", timeZone: "America/New_York" },
        },
        {
          startTime: "2026-11-17T11:00:00-05:00", endTime: "2026-11-17T17:00:00-05:00", durationMinutes: 360,
          start: { dateTime: "2026-11-17T11:00:00-05:00", timeZone: "America/New_York" },
          end: { dateTime: "2026-11-17T17:00:00-05:00", timeZone: "America/New_York" },
        },
      ],
    });
  });

  it("retries a failed free/busy read once, as a read", async () => {
    let count = 0;
    const { fetch, calls } = fakeGoogle(() => (count++ === 0 ? json({}, 503) : json({ calendars: { "avery@example.test": { busy: [] } } })));
    const result = await suggestTime.call({ ...input, attendeeEmails: ["avery@example.test"], timeZone: "UTC" }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("falls back to reading each calendar's events when the grant has no free/busy permission", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/freeBusy")) return json({ error: { code: 403, details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 403);
      if (url.pathname.includes("avery")) {
        return json({ timeZone: "America/New_York", items: [{ start: { dateTime: "2026-11-17T09:00:00-05:00" }, end: { dateTime: "2026-11-17T12:00:00-05:00" } }] });
      }
      return json({ timeZone: "America/New_York", items: [{ transparency: "transparent", start: { dateTime: "2026-11-17T12:00:00-05:00" }, end: { dateTime: "2026-11-17T13:00:00-05:00" } }] });
    });
    const result = await suggestTime.call({ ...input, timeZone: "America/New_York" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "POST /calendar/v3/freeBusy",
      "GET /calendar/v3/calendars/avery%40example.test/events",
      "GET /calendar/v3/calendars/blake%40example.test/events",
    ]);
    expect(calls[1]!.url.searchParams.get("singleEvents")).toBe("true");
    expect((result.structuredContent as { timeSlots: Array<{ startTime: string }> }).timeSlots.map((slot) => slot.startTime)).toEqual(["2026-11-17T12:00:00-05:00"]);
  });

  it("names the people whose calendars cannot be read in the fallback", async () => {
    const { fetch } = fakeGoogle(({ url }) => {
      if (url.pathname.endsWith("/freeBusy")) return json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403);
      if (url.pathname.includes("blake")) return json({ error: { code: 404 } }, 404);
      return json({ items: [] });
    });
    const result = await suggestTime.call({ ...input, timeZone: "UTC" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "Google could not share availability for: blake@example.test. Remove them or ask them to share their calendar." }] });
  });
});
