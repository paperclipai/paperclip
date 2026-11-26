import { AVAILABILITIES, EVENT_TYPES, NOTIFICATION_LEVELS } from "./event.js";

const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const int = (description: string) => ({ type: "integer", description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const TIME_RULES = "Pass the local time with no UTC offset and no trailing Z (for example 2026-04-30T10:00:00); include an offset only if the user stated one. If the user named a time zone, put its IANA name in timeZone.";

export const calendarIdInput = str("Optional. ID of the calendar, an email address that list_calendars can resolve. Default: the primary calendar.");
export const timeZoneInput = (purpose: string) => str(`Optional. IANA time zone name (for example America/Los_Angeles) ${purpose} Set it only when the user states a time zone, and always set it when they do. When unset, the calendar's own time zone is used.`);
export const notificationLevelInput = (fallback: string) => ({
  type: "string",
  enum: [...NOTIFICATION_LEVELS],
  description: `Optional. Which email notifications to send. NONE: none. EXTERNAL_ONLY: attendees outside the organizer's domain only. ALL: all attendees. Default: ${fallback}.`,
});

export const reminderSchema = {
  type: "object",
  properties: {
    method: { type: "string", enum: ["email", "popup"], description: "Delivery method." },
    minutes: int("Minutes before the event that the reminder fires."),
  },
  required: ["method", "minutes"],
} as const;

export const attendeeSchema = {
  type: "object",
  properties: {
    id: str("Output only. Profile ID."),
    email: str("Required. The attendee's email address."),
    displayName: str("Optional. Name."),
    organizer: bool("Output only. Whether the attendee is the organizer."),
    self: bool("Output only. Whether this entry is the calendar this copy of the event is on."),
    resource: bool("Optional. Whether the attendee is a resource such as a room. Can only be set when the attendee is added."),
    optionalAttendee: bool("Optional. Whether the attendee is optional."),
    responseStatus: { type: "string", enum: ["needsAction", "declined", "tentative", "accepted"], description: "Optional. Response status." },
    comment: str("Output only. Response comment."),
    additionalGuests: int("Optional. Number of additional guests."),
  },
  required: ["email"],
} as const;

export const attachmentSchema = {
  type: "object",
  properties: { fileUrl: str("Required. Link to the file."), title: str("Optional. Title.") },
  required: ["fileUrl"],
} as const;

export const guestPermissionsSchema = {
  type: "object",
  properties: {
    guestsCanInviteOthers: bool("Optional. Whether guests can invite others."),
    guestsCanModify: bool("Optional. Whether guests can change the event."),
    guestsCanSeeGuests: bool("Optional. Whether guests can see the other guests."),
  },
} as const;

export const officeLocationSchema = {
  type: "object",
  properties: {
    buildingId: str("Optional. Building ID."),
    floorId: str("Optional. Floor ID."),
    floorSectionId: str("Optional. Floor section ID."),
    deskId: str("Optional. Desk ID."),
    label: str("Optional. Label shown for the office location."),
  },
} as const;

export const WORKING_LOCATION_TYPES = ["WORKING_LOCATION_TYPE_UNSPECIFIED", "HOME_OFFICE", "CUSTOM_LOCATION", "OFFICE_LOCATION"] as const;

export const workingLocationSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...WORKING_LOCATION_TYPES], description: "Optional. Working location type. Unspecified means HOME_OFFICE." },
    customLocationLabel: str("Optional. Label of a custom location. Required for CUSTOM_LOCATION."),
    officeLocation: { ...officeLocationSchema, description: "Optional. Office location details. Required for OFFICE_LOCATION." },
    timeZone: str("Output only. Time zone."),
  },
} as const;

export const availabilityInput = { type: "string", enum: [...AVAILABILITIES], description: "Optional. Whether the event blocks time. Unspecified means busy." } as const;
export const eventTypeInput = { type: "string", enum: [...EVENT_TYPES], description: "Optional. Event type. Cannot be changed later. FROM_GMAIL events cannot be created." } as const;
export const visibilityInput = { type: "string", enum: ["default", "public", "private"], description: "Optional. Visibility: default (the calendar's default), public, or private (only attendees see details)." } as const;
export const colorIdInput = str("Optional. Event color ID, \"1\" to \"11\".");

const dateOrDateTime = {
  type: "object",
  properties: {
    date: str("Date (YYYY-MM-DD), for all-day events."),
    dateTime: str("RFC 3339 date-time with offset, for timed events."),
    timeZone: str("IANA time zone of the event's start or end."),
  },
} as const;

const principalSchema = {
  type: "object",
  properties: { email: str("Email."), displayName: str("Name."), self: bool("Whether this is the calendar this copy of the event is on.") },
} as const;

const codeSchema = {
  type: "object",
  properties: {
    codeType: { type: "string", enum: ["CODE_TYPE_UNSPECIFIED", "ACCESS_CODE", "PASSCODE", "PASSWORD", "MEETING_CODE", "PIN"], description: "Code type." },
    value: str("Code."),
  },
} as const;

const entryPointSchema = {
  type: "object",
  properties: { uri: str("Link or address of the entry point."), codes: { type: "array", items: codeSchema, description: "Codes needed to join." } },
} as const;

export const eventSchema = {
  type: "object",
  properties: {
    id: str("Event ID."),
    status: { type: "string", enum: ["confirmed", "tentative", "cancelled"], description: "Status." },
    htmlLink: str("Link to the event in Google Calendar."),
    created: str("Creation time."),
    updated: str("Last change time."),
    summary: str("Title."),
    description: str("Description. Can contain HTML."),
    location: str("Location."),
    creator: principalSchema,
    organizer: principalSchema,
    start: { ...dateOrDateTime, description: "Start (inclusive)." },
    end: { ...dateOrDateTime, description: "End (exclusive). For all-day events, the day after the last day." },
    recurrence: strings("RRULE, EXRULE, RDATE or EXDATE lines (RFC 5545). Only on a recurring series."),
    recurringEventId: str("For one instance of a recurring series, the series' event ID."),
    originalStartTime: { ...dateOrDateTime, description: "For one instance of a recurring series, when it would start by the recurrence rule." },
    transparency: str("Deprecated: use availability."),
    visibility: str("Visibility."),
    attendees: { type: "array", items: attendeeSchema, description: "Attendees." },
    conferenceUrl: str("Deprecated: use conferenceData. Video meeting link."),
    conferenceData: {
      type: "object",
      properties: {
        solutionName: str("Conference product name."),
        joiningNotesText: str("Joining notes."),
        videoEntryPoint: entryPointSchema,
        phoneEntryPoints: {
          type: "array",
          items: { type: "object", properties: { phoneNumber: str("Phone number."), codes: { type: "array", items: codeSchema }, regionCode: str("Region code."), isTollNumber: bool("Whether the number is a toll call.") } },
        },
        sipEntryPoint: entryPointSchema,
        moreDetailsEntryPoint: entryPointSchema,
      },
      description: "Conference details, including a video link if there is one.",
    },
    colorId: str("Color ID, \"1\" to \"11\"."),
    overrideReminders: { type: "array", items: reminderSchema, description: "Reminders that replace the calendar's defaults for this user." },
    attachments: { type: "array", items: attachmentSchema, description: "File attachments." },
    guestPermissions: guestPermissionsSchema,
    eventType: { type: "string", enum: [...EVENT_TYPES], description: "Event type." },
    workingLocationProperties: workingLocationSchema,
    availability: { type: "string", enum: [...AVAILABILITIES], description: "Whether the event blocks time." },
    useDefaultReminders: bool("Whether the calendar's default reminders apply."),
  },
} as const;

export const pageSizeInput = (fallback: number, max: number) => int(`Optional. Maximum results per page. Default ${fallback}, at most ${max}.`);
export const pageTokenInput = str("Optional. The nextPageToken from the previous page.");
