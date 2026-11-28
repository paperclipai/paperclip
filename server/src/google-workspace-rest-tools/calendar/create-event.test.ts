import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { createEvent, createEventRequest, eventTimes, mergedAttendees } from "./create-event.js";
import { TIMED_EVENT } from "./fixtures/calendar-rest.js";

const base = { summary: "Planning", startTime: "2026-11-18T10:00:00", endTime: "2026-11-18T11:00:00" };

describe("create_event times", () => {
  it.each([
    ["timed, in the given zone", { startTime: "2026-11-18T10:00:00", endTime: "2026-11-18T11:00:00" }, "America/New_York",
      { start: { dateTime: "2026-11-18T10:00:00-05:00", timeZone: "America/New_York" }, end: { dateTime: "2026-11-18T11:00:00-05:00", timeZone: "America/New_York" } }],
    ["timed, a stated offset is converted into the zone", { startTime: "2026-11-18T15:00:00Z", endTime: "2026-11-18T16:00:00Z" }, "Europe/Berlin",
      { start: { dateTime: "2026-11-18T16:00:00+01:00", timeZone: "Europe/Berlin" }, end: { dateTime: "2026-11-18T17:00:00+01:00", timeZone: "Europe/Berlin" } }],
    ["timed, starting in the missing DST hour moves forward", { startTime: "2026-03-08T02:30:00", endTime: "2026-03-08T04:00:00" }, "America/New_York",
      { start: { dateTime: "2026-03-08T03:30:00-04:00", timeZone: "America/New_York" }, end: { dateTime: "2026-03-08T04:00:00-04:00", timeZone: "America/New_York" } }],
    ["timed, across the end of DST", { startTime: "2026-11-01T00:30:00", endTime: "2026-11-01T03:00:00" }, "America/New_York",
      { start: { dateTime: "2026-11-01T00:30:00-04:00", timeZone: "America/New_York" }, end: { dateTime: "2026-11-01T03:00:00-05:00", timeZone: "America/New_York" } }],
    ["all-day, one day given as the same date", { allDay: true, startTime: "2026-11-20", endTime: "2026-11-20" }, undefined,
      { start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }],
    ["all-day, exclusive midnight end", { allDay: true, startTime: "2026-11-20T00:00:00", endTime: "2026-11-22T00:00:00" }, undefined,
      { start: { date: "2026-11-20" }, end: { date: "2026-11-22" } }],
    ["all-day, an end during a day includes that day", { allDay: true, startTime: "2026-11-20T00:00:00", endTime: "2026-11-21T23:59:59" }, undefined,
      { start: { date: "2026-11-20" }, end: { date: "2026-11-22" } }],
    ["all-day, offsets do not move the date", { allDay: true, startTime: "2026-11-20T00:00:00-08:00", endTime: "2026-11-21T00:00:00-08:00" }, undefined,
      { start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }],
  ])("%s", (_name, input, timeZone, expected) => {
    expect(eventTimes(input, timeZone)).toEqual(expected);
  });

  it.each([
    [{ startTime: "2026-11-18T11:00:00", endTime: "2026-11-18T10:00:00" }, "UTC", /after startTime/],
    [{ allDay: true, startTime: "2026-11-20", endTime: "2026-11-19" }, undefined, /not be before/],
    [{ startTime: "2026-11-18T10:00:00", endTime: "2026-11-18T11:00:00" }, undefined, /time zone is needed/],
  ])("refuses %j", (input, timeZone, message) => {
    expect(() => eventTimes(input, timeZone)).toThrow(message);
  });
});

describe("create_event request", () => {
  it("builds a full insert with Google's default of notifying all attendees", () => {
    const request = createEventRequest({
      ...base,
      calendarId: "team@example.test",
      description: "<b>Agenda</b>",
      location: "Room 4",
      attendees: [{ email: "blake@example.test", optionalAttendee: true, displayName: "Blake" }, { email: "room@resource.example.test", resource: true }],
      attendeeEmails: ["Blake@example.test", "casey@example.test"],
      recurrenceData: ["RRULE:FREQ=WEEKLY;COUNT=4"],
      overrideReminders: [{ method: "email", minutes: 30 }],
      visibility: "private",
      colorId: "11",
      guestPermissions: { guestsCanSeeGuests: false, guestsCanModify: true },
      availability: "AVAILABILITY_FREE",
      eventType: "FOCUS_TIME",
    }, "America/New_York", "req-1");
    expect(request).toEqual({
      method: "POST",
      host: "www.googleapis.com",
      path: "/calendar/v3/calendars/team%40example.test/events",
      query: { sendUpdates: "all", conferenceDataVersion: undefined, supportsAttachments: undefined },
      body: {
        summary: "Planning",
        description: "<b>Agenda</b>",
        location: "Room 4",
        start: { dateTime: "2026-11-18T10:00:00-05:00", timeZone: "America/New_York" },
        end: { dateTime: "2026-11-18T11:00:00-05:00", timeZone: "America/New_York" },
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
        attendees: [
          { email: "blake@example.test", displayName: "Blake", optional: true },
          { email: "room@resource.example.test", resource: true },
          { email: "casey@example.test" },
        ],
        reminders: { useDefault: false, overrides: [{ method: "email", minutes: 30 }] },
        visibility: "private",
        colorId: "11",
        guestsCanModify: true,
        guestsCanSeeOtherGuests: false,
        transparency: "transparent",
        eventType: "focusTime",
      },
    });
  });

  it.each([
    ["NONE", "none"],
    ["EXTERNAL_ONLY", "externalOnly"],
    ["NOTIFICATION_LEVEL_UNSPECIFIED", "all"],
  ] as const)("sends notificationLevel %s as sendUpdates=%s", (notificationLevel, expected) => {
    expect(createEventRequest({ ...base, notificationLevel }, "UTC", "r").query!.sendUpdates).toBe(expected);
  });

  it("asks Google to create a Meet link, or attaches an existing one", () => {
    const created = createEventRequest({ ...base, addGoogleMeetUrl: true }, "UTC", "req-9");
    expect(created.query!.conferenceDataVersion).toBe(1);
    expect((created.body as { conferenceData: unknown }).conferenceData).toEqual({ createRequest: { requestId: "req-9", conferenceSolutionKey: { type: "hangoutsMeet" } } });
    const attached = createEventRequest({ ...base, addGoogleMeetUrl: true, googleMeetUrl: "https://meet.google.com/abc-defg-hij?authuser=0" }, "UTC", "r");
    expect((attached.body as { conferenceData: unknown }).conferenceData).toEqual({
      conferenceId: "abc-defg-hij",
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
    });
    expect(() => createEventRequest({ ...base, googleMeetUrl: "https://evil.example.test/abc-defg-hij" }, "UTC", "r")).toThrow(/Google Meet link/);
  });

  it("marks attachments and working locations", () => {
    const request = createEventRequest({
      ...base,
      allDay: true,
      eventType: "WORKING_LOCATION",
      workingLocationProperties: { type: "CUSTOM_LOCATION", customLocationLabel: "Cafe" },
      attachments: [{ fileUrl: "https://drive.google.com/open?id=f1", title: "Notes" }],
    }, undefined, "r");
    expect(request.query!.supportsAttachments).toBe(true);
    expect(request.body).toMatchObject({
      start: { date: "2026-11-18" },
      eventType: "workingLocation",
      workingLocationProperties: { type: "customLocation", customLocation: { label: "Cafe" } },
      attachments: [{ fileUrl: "https://drive.google.com/open?id=f1", title: "Notes" }],
    });
  });

  it.each([
    [{ useDefaultReminders: true }, { useDefault: true, overrides: [] }],
    [{ useDefaultReminders: false }, { useDefault: false, overrides: [] }],
    [{}, undefined],
  ])("sets reminders for %j", (input, expected) => {
    expect((createEventRequest({ ...base, ...input }, "UTC", "r").body as { reminders?: unknown }).reminders).toEqual(expected);
  });

  it("refuses contradictory reminders and FROM_GMAIL events", () => {
    expect(() => createEventRequest({ ...base, useDefaultReminders: true, overrideReminders: [{ method: "popup", minutes: 5 }] }, "UTC", "r")).toThrow(/useDefaultReminders/);
    expect(() => createEventRequest({ ...base, eventType: "FROM_GMAIL" }, "UTC", "r")).toThrow(/FROM_GMAIL/);
  });

  it("drops duplicate attendees case-insensitively", () => {
    expect(mergedAttendees({ attendees: [{ email: "A@example.test" }], attendeeEmails: ["a@example.test", "b@example.test"] }))
      .toEqual([{ email: "A@example.test" }, { email: "b@example.test" }]);
  });
});

describe("create_event tool", () => {
  it("reads the calendar's time zone when none is given, then inserts once", async () => {
    const { fetch, calls } = fakeGoogle(({ method }) => (method === "GET" ? json({ timeZone: "Asia/Kolkata" }) : json(TIMED_EVENT)));
    const result = await createEvent.call(base, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[1]!.body).toMatchObject({ start: { dateTime: "2026-11-18T10:00:00+05:30", timeZone: "Asia/Kolkata" } });
    expect(calls[1]!.url.searchParams.get("sendUpdates")).toBe("all");
    expect(result.structuredContent).toMatchObject({ id: "evt0001timed" });
  });

  it("does not read the time zone for an all-day event or when the caller gives one", async () => {
    const { fetch, calls } = fakeGoogle(() => json(TIMED_EVENT));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    await createEvent.call({ ...base, allDay: true }, http);
    await createEvent.call({ ...base, timeZone: "UTC" }, http);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
  });

  it("never retries the insert and says the outcome is unknown when it fails after sending", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 503 } }, 503));
    const result = await createEvent.call({ ...base, timeZone: "UTC" }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
  });

  it("sends nothing for bad input", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const input of [
      { ...base, timeZone: "Not/AZone" },
      { ...base, startTime: "next tuesday" },
      { ...base, attendees: [{ email: "Blake <blake@example.test>" }] },
      { ...base, recurrenceData: ["FREQ=DAILY"] },
      { ...base, colorId: "12" },
      { summary: "x" },
    ]) {
      expect((await createEvent.call(input, http)).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("create_event sub-second times", () => {
  it("keeps milliseconds so a short event never collapses to zero length", () => {
    expect(eventTimes({ startTime: "2026-11-18T10:00:00.100Z", endTime: "2026-11-18T10:00:00.900Z" }, "UTC")).toEqual({
      start: { dateTime: "2026-11-18T10:00:00.100Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-18T10:00:00.900Z", timeZone: "UTC" },
    });
  });
});
