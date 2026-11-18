import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import type { RestEvent } from "./event.js";
import { ALL_DAY_EVENT, RECURRING_INSTANCE, RECURRING_SERIES, TIMED_EVENT } from "./fixtures/calendar-rest.js";
import { updatedAttachments, updatedAttendees, updatedTimes, updateEvent, updateEventRequest, updateNeedsTimeZone } from "./update-event.js";

const NY = "America/New_York";
const DST_EVENT: RestEvent = {
  id: "dst1",
  start: { dateTime: "2026-10-31T23:00:00-04:00", timeZone: NY },
  end: { dateTime: "2026-11-01T03:00:00-05:00", timeZone: NY },
};

describe("update_event times", () => {
  it.each([
    ["only the start: keeps the duration", TIMED_EVENT, { startTime: "2026-11-18T14:00:00" }, NY,
      { start: { dateTime: "2026-11-18T14:00:00-05:00", timeZone: NY, date: null }, end: { dateTime: "2026-11-18T15:00:00-05:00", timeZone: NY, date: null } }],
    ["only the start: keeps the elapsed duration across a DST change", DST_EVENT, { startTime: "2026-11-07T23:00:00" }, NY,
      { start: { dateTime: "2026-11-07T23:00:00-05:00", timeZone: NY, date: null }, end: { dateTime: "2026-11-08T04:00:00-05:00", timeZone: NY, date: null } }],
    ["only the end", TIMED_EVENT, { endTime: "2026-11-17T12:30:00" }, NY,
      { start: { dateTime: "2026-11-17T10:00:00-05:00", timeZone: NY, date: null }, end: { dateTime: "2026-11-17T12:30:00-05:00", timeZone: NY, date: null } }],
    ["only the time zone: same moment, shown in the new zone", TIMED_EVENT, { timeZone: "Europe/London" }, "Europe/London",
      { start: { dateTime: "2026-11-17T15:00:00Z", timeZone: "Europe/London", date: null }, end: { dateTime: "2026-11-17T16:00:00Z", timeZone: "Europe/London", date: null } }],
    ["timed to all-day", TIMED_EVENT, { allDay: true, startTime: "2026-11-20", endTime: "2026-11-20" }, NY,
      { start: { date: "2026-11-20", dateTime: null, timeZone: null }, end: { date: "2026-11-21", dateTime: null, timeZone: null } }],
    ["all-day to timed", ALL_DAY_EVENT, { allDay: false, startTime: "2026-11-20T09:00:00", endTime: "2026-11-20T10:00:00" }, NY,
      { start: { dateTime: "2026-11-20T09:00:00-05:00", timeZone: NY, date: null }, end: { dateTime: "2026-11-20T10:00:00-05:00", timeZone: NY, date: null } }],
    ["all-day, only the start: keeps the number of days", ALL_DAY_EVENT, { startTime: "2026-11-30" }, undefined,
      { start: { date: "2026-11-30", dateTime: null, timeZone: null }, end: { date: "2026-12-02", dateTime: null, timeZone: null } }],
    ["all-day, only the end", ALL_DAY_EVENT, { endTime: "2026-11-24" }, undefined,
      { start: { date: "2026-11-20", dateTime: null, timeZone: null }, end: { date: "2026-11-24", dateTime: null, timeZone: null } }],
  ] as const)("%s", (_name, current, input, timeZone, expected) => {
    expect(updatedTimes({ eventId: "e", ...input }, current, timeZone)).toEqual(expected);
  });

  it("leaves times alone when none are given, and for a time zone on an all-day event", () => {
    expect(updatedTimes({ eventId: "e", summary: "x" }, TIMED_EVENT, NY)).toBeUndefined();
    expect(updatedTimes({ eventId: "e", timeZone: NY }, ALL_DAY_EVENT, NY)).toBeUndefined();
  });

  it.each([
    [{ allDay: true, startTime: "2026-11-20" }, /must both be given/],
    [{ endTime: "2026-11-17T09:00:00" }, /after startTime/],
  ])("refuses %j", (input, message) => {
    expect(() => updatedTimes({ eventId: "e", ...input }, TIMED_EVENT, NY)).toThrow(message);
  });

  it.each([
    [{ startTime: "2026-11-18T10:00:00" }, { start: { dateTime: "2026-11-17T10:00:00-05:00" } }, true],
    [{ startTime: "2026-11-18T10:00:00" }, TIMED_EVENT, false],
    [{ startTime: "2026-11-18" }, ALL_DAY_EVENT, false],
    [{ summary: "x" }, { start: { dateTime: "2026-11-17T10:00:00-05:00" } }, false],
  ])("needs the calendar's time zone for %j: %s", (input, current, expected) => {
    expect(updateNeedsTimeZone({ eventId: "e", ...input }, current)).toBe(expected);
  });
});

describe("update_event attendees and attachments", () => {
  it("adds, updates and removes attendees without touching the others", () => {
    expect(updatedAttendees({
      eventId: "e",
      addedAttendees: [{ email: "Blake@example.test", optionalAttendee: false }, { email: "drew@example.test" }],
      addedAttendeeEmails: ["erin@example.test"],
      removedAttendeeEmails: ["ROOM-4@resource.example.test"],
    }, TIMED_EVENT)).toEqual([
      { email: "avery@example.test", organizer: true, self: true, responseStatus: "accepted" },
      { email: "Blake@example.test", displayName: "Blake", optional: false, responseStatus: "needsAction" },
      { email: "drew@example.test" },
      { email: "erin@example.test" },
    ]);
    expect(updatedAttendees({ eventId: "e" }, TIMED_EVENT)).toBeUndefined();
  });

  it("adds and removes attachments by link", () => {
    expect(updatedAttachments({
      eventId: "e",
      addedAttachments: [{ fileUrl: "https://drive.google.com/open?id=file-2" }, { fileUrl: "https://drive.google.com/open?id=file-1" }],
      removedAttachmentFileUrls: ["https://drive.google.com/open?id=file-1"],
    }, TIMED_EVENT)).toEqual([{ fileUrl: "https://drive.google.com/open?id=file-2" }, { fileUrl: "https://drive.google.com/open?id=file-1" }]);
  });
});

describe("update_event request", () => {
  it("patches only what changed, guarded by the event's ETag", () => {
    expect(updateEventRequest({ eventId: "evt0001timed", summary: "Renamed", availability: "AVAILABILITY_FREE", useDefaultReminders: true }, TIMED_EVENT, NY, "r")).toEqual({
      method: "PATCH",
      host: "www.googleapis.com",
      path: "/calendar/v3/calendars/primary/events/evt0001timed",
      query: { sendUpdates: "all", conferenceDataVersion: undefined, supportsAttachments: undefined },
      body: { summary: "Renamed", reminders: { useDefault: true, overrides: [] }, transparency: "transparent" },
      ifMatch: "\"3381234567890000\"",
    });
  });

  it("sends nothing when there is nothing to change", () => {
    expect(updateEventRequest({ eventId: "e" }, TIMED_EVENT, NY, "r")).toBeUndefined();
  });

  it("follows the notification level", () => {
    expect(updateEventRequest({ eventId: "e", location: "x", notificationLevel: "NONE" }, TIMED_EVENT, NY, "r")!.query!.sendUpdates).toBe("none");
  });
});

describe("update_event tool", () => {
  it("reads the event, then patches it once in the event's own time zone", async () => {
    const { fetch, calls } = fakeGoogle(({ method }) => json(method === "GET" ? TIMED_EVENT : { ...TIMED_EVENT, summary: "Moved" }));
    const result = await updateEvent.call({ eventId: "evt0001timed", startTime: "2026-11-19T09:00:00" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.headers["if-match"]).toBe("\"3381234567890000\"");
    expect(calls[1]!.body).toEqual({
      start: { dateTime: "2026-11-19T09:00:00-05:00", timeZone: NY, date: null },
      end: { dateTime: "2026-11-19T10:00:00-05:00", timeZone: NY, date: null },
    });
    expect(result.structuredContent).toMatchObject({ summary: "Moved" });
  });

  it.each([
    ["a series ID changes the whole series", RECURRING_SERIES, { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"] }, "recurringEventId"],
    ["an occurrence ID changes that occurrence only", RECURRING_INSTANCE, { recurringEventId: "evt0003series" }, "recurrence"],
  ] as const)("%s, and the result shows which", async (_name, event, shows, absent) => {
    const { fetch, calls } = fakeGoogle(({ method }) => json(method === "GET" ? event : { ...event, summary: "Renamed" }));
    const result = await updateEvent.call({ eventId: event.id!, summary: "Renamed" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.pathname.split("/").at(-1)}`)).toEqual([`GET ${event.id}`, `PATCH ${event.id}`]);
    expect(result.structuredContent).toMatchObject({ ...shows, summary: "Renamed" });
    expect(result.structuredContent).not.toHaveProperty(absent);
  });

  it("returns the event unchanged without writing when nothing is asked", async () => {
    const { fetch, calls } = fakeGoogle(() => json(TIMED_EVENT));
    const result = await updateEvent.call({ eventId: "evt0001timed" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(result.structuredContent).toMatchObject({ id: "evt0001timed" });
  });

  it("does not retry a failed patch and warns that it may have applied", async () => {
    const { fetch, calls } = fakeGoogle(({ method }) => {
      if (method === "GET") return json(TIMED_EVENT);
      throw new TypeError("socket hang up");
    });
    const result = await updateEvent.call({ eventId: "evt0001timed", summary: "x" }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect((result.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
  });

  it("validates times before calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json(TIMED_EVENT));
    expect((await updateEvent.call({ eventId: "e", startTime: "soon" }, createGoogleHttp({ accessToken: "t", fetch }))).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
