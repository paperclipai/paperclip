import { describe, expect, it } from "vitest";
import { googleRequestUrl } from "../google-http.js";
import { ALL_DAY_EVENT, RECURRING_INSTANCE, RECURRING_SERIES, TIMED_EVENT, WORKING_LOCATION_EVENT } from "./fixtures/calendar-rest.js";
import { calendarId, eventId, eventPath, getEventRequest, sendUpdates, toMcpEvent } from "./event.js";

describe("toMcpEvent", () => {
  it("maps a timed event to Google's MCP Event", () => {
    expect(toMcpEvent(TIMED_EVENT)).toEqual({
      id: "evt0001timed",
      status: "confirmed",
      htmlLink: "https://www.google.com/calendar/event?eid=ZXZ0MDAwMXRpbWVk",
      created: "2026-10-01T12:00:00.000Z",
      updated: "2026-10-02T12:00:00.000Z",
      summary: "Planning review",
      description: "<p>Agenda</p>",
      location: "Room 4",
      creator: { email: "avery@example.test", self: true },
      organizer: { email: "avery@example.test", displayName: "Avery", self: true },
      start: { dateTime: "2026-11-17T10:00:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-17T11:00:00-05:00", timeZone: "America/New_York" },
      attendees: [
        { email: "avery@example.test", organizer: true, self: true, responseStatus: "accepted" },
        { email: "blake@example.test", displayName: "Blake", optionalAttendee: true, responseStatus: "needsAction" },
        { email: "room-4@resource.example.test", resource: true, responseStatus: "accepted" },
      ],
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      conferenceData: {
        solutionName: "Google Meet",
        joiningNotesText: "Join early",
        videoEntryPoint: { uri: "https://meet.google.com/abc-defg-hij", codes: [{ codeType: "MEETING_CODE", value: "abc-defg-hij" }] },
        phoneEntryPoints: [{ phoneNumber: "+1 555-0100", codes: [{ codeType: "PIN", value: "123456789" }], regionCode: "US" }],
        moreDetailsEntryPoint: { uri: "https://tel.meet/abc-defg-hij?pin=1" },
      },
      colorId: "7",
      overrideReminders: [{ method: "popup", minutes: 10 }],
      attachments: [{ fileUrl: "https://drive.google.com/open?id=file-1", title: "Plan" }],
      guestPermissions: { guestsCanModify: true, guestsCanSeeGuests: false },
      eventType: "DEFAULT",
      availability: "AVAILABILITY_BUSY",
      useDefaultReminders: false,
    });
  });

  it.each([
    ["an all-day event keeps dates and is free when transparent", ALL_DAY_EVENT, {
      start: { date: "2026-11-20" }, end: { date: "2026-11-22" }, availability: "AVAILABILITY_FREE", transparency: "transparent",
    }],
    ["one occurrence names its series and original start", RECURRING_INSTANCE, {
      recurringEventId: "evt0003series", originalStartTime: { dateTime: "2026-11-18T10:00:00-05:00", timeZone: "America/New_York" },
    }],
    ["a series carries its recurrence rules", RECURRING_SERIES, { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"] }],
    ["a working location maps its office", WORKING_LOCATION_EVENT, {
      eventType: "WORKING_LOCATION", workingLocationProperties: { type: "OFFICE_LOCATION", officeLocation: { buildingId: "b1", label: "HQ" } },
    }],
  ])("%s", (_name, event, expected) => {
    expect(toMcpEvent(event)).toMatchObject(expected);
  });

  it("leaves out fields Google did not return", () => {
    expect(toMcpEvent({ id: "bare" })).toEqual({ id: "bare", availability: "AVAILABILITY_BUSY" });
  });
});

describe("notification levels", () => {
  it.each([
    [undefined, "ALL", "all"],
    ["NOTIFICATION_LEVEL_UNSPECIFIED", "ALL", "all"],
    [undefined, "EXTERNAL_ONLY", "externalOnly"],
    ["NONE", "ALL", "none"],
    ["EXTERNAL_ONLY", "ALL", "externalOnly"],
    ["ALL", "EXTERNAL_ONLY", "all"],
  ] as const)("%s with default %s sends %s", (level, fallback, expected) => {
    expect(sendUpdates(level, fallback)).toBe(expected);
  });
});

describe("IDs and paths", () => {
  it("encodes calendar IDs, including holiday calendars with #", () => {
    expect(googleRequestUrl(getEventRequest("en.usa#holiday@group.v.calendar.google.com", "abc_20261118T150000Z")))
      .toBe("https://www.googleapis.com/calendar/v3/calendars/en.usa%23holiday%40group.v.calendar.google.com/events/abc_20261118T150000Z");
    expect(eventPath(undefined, "e1")).toBe("/calendar/v3/calendars/primary/events/e1");
  });

  it.each(["", ".", "..", "a/b", "a?b", "a b", "a%2f"])("rejects calendar ID %j", (value) => {
    expect(calendarId.safeParse(value).success).toBe(false);
  });

  it.each(["", ".", "..", "a/b", "a?b", "a#b"])("rejects event ID %j", (value) => {
    expect(eventId.safeParse(value).success).toBe(false);
  });
});
