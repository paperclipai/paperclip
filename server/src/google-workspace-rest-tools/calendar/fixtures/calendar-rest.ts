import type { RestEvent, RestEventList } from "../event.js";

export const TIMED_EVENT: RestEvent = {
  id: "evt0001timed",
  etag: "\"3381234567890000\"",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=ZXZ0MDAwMXRpbWVk",
  created: "2026-10-01T12:00:00.000Z",
  updated: "2026-10-02T12:00:00.000Z",
  summary: "Planning review",
  description: "<p>Agenda</p>",
  location: "Room 4",
  colorId: "7",
  creator: { email: "avery@example.test", self: true },
  organizer: { email: "avery@example.test", displayName: "Avery", self: true },
  start: { dateTime: "2026-11-17T10:00:00-05:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-11-17T11:00:00-05:00", timeZone: "America/New_York" },
  attendees: [
    { email: "avery@example.test", organizer: true, self: true, responseStatus: "accepted" },
    { email: "blake@example.test", displayName: "Blake", optional: true, responseStatus: "needsAction" },
    { email: "room-4@resource.example.test", resource: true, responseStatus: "accepted" },
  ],
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  conferenceData: {
    conferenceId: "abc-defg-hij",
    conferenceSolution: { name: "Google Meet", key: { type: "hangoutsMeet" } },
    entryPoints: [
      { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij", meetingCode: "abc-defg-hij" },
      { entryPointType: "phone", uri: "tel:+1-555-0100", label: "+1 555-0100", pin: "123456789", regionCode: "US" },
      { entryPointType: "more", uri: "https://tel.meet/abc-defg-hij?pin=1" },
    ],
    notes: "Join early",
  },
  reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
  attachments: [{ fileUrl: "https://drive.google.com/open?id=file-1", title: "Plan" }],
  guestsCanModify: true,
  guestsCanSeeOtherGuests: false,
  eventType: "default",
};

export const ALL_DAY_EVENT: RestEvent = {
  id: "evt0002allday",
  status: "confirmed",
  summary: "Offsite",
  start: { date: "2026-11-20" },
  end: { date: "2026-11-22" },
  transparency: "transparent",
  eventType: "default",
};

export const RECURRING_INSTANCE: RestEvent = {
  id: "evt0003series_20261118T150000Z",
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-11-18T10:00:00-05:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-11-18T10:15:00-05:00", timeZone: "America/New_York" },
  recurringEventId: "evt0003series",
  originalStartTime: { dateTime: "2026-11-18T10:00:00-05:00", timeZone: "America/New_York" },
  eventType: "default",
};

export const RECURRING_SERIES: RestEvent = {
  id: "evt0003series",
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-01-05T10:00:00-05:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-01-05T10:15:00-05:00", timeZone: "America/New_York" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"],
  eventType: "default",
};

export const WORKING_LOCATION_EVENT: RestEvent = {
  id: "evt0004where",
  summary: "Office",
  start: { date: "2026-11-19" },
  end: { date: "2026-11-20" },
  transparency: "transparent",
  visibility: "public",
  eventType: "workingLocation",
  workingLocationProperties: { type: "officeLocation", officeLocation: { buildingId: "b1", label: "HQ" } },
};

export const INVITED_EVENT: RestEvent = {
  id: "evt0005invite",
  etag: "\"3381234567899999\"",
  summary: "Vendor call",
  start: { dateTime: "2026-11-19T15:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-11-19T15:30:00Z", timeZone: "UTC" },
  organizer: { email: "casey@partner.example.test" },
  attendees: [
    { email: "casey@partner.example.test", organizer: true, responseStatus: "accepted" },
    { email: "avery@example.test", self: true, responseStatus: "needsAction" },
    { email: "drew@example.test", responseStatus: "tentative", comment: "Might be late" },
  ],
};

export function eventList(items: RestEvent[], extra: Partial<RestEventList> = {}): RestEventList {
  return { summary: "avery@example.test", timeZone: "America/New_York", accessRole: "owner", updated: "2026-11-16T00:00:00Z", items, ...extra };
}
