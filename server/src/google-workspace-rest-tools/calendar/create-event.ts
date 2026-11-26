import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import {
  attachmentArg,
  attendeeArg,
  allDayTimes,
  colorIdArg,
  conferenceBody,
  email,
  guestPermissionsArg,
  guestPermissionsBody,
  reminderArg,
  remindersBody,
  restAttendee,
  timedTimes,
  visibilityArg,
  workingLocationArg,
  workingLocationBody,
} from "./event-input.js";
import {
  assertTimeZone,
  AVAILABILITIES,
  CALENDAR_HOST,
  calendarId,
  calendarTimeZone,
  EVENT_TYPES,
  eventsPath,
  NOTIFICATION_LEVELS,
  restEventType,
  restTransparency,
  sendUpdates,
  timeZoneArg,
  toMcpEvent,
  type RestAttendee,
  type RestDateTime,
  type RestEvent,
} from "./event.js";
import {
  attachmentSchema,
  attendeeSchema,
  availabilityInput,
  calendarIdInput,
  colorIdInput,
  eventSchema,
  eventTypeInput,
  guestPermissionsSchema,
  notificationLevelInput,
  reminderSchema,
  TIME_RULES,
  timeZoneInput,
  visibilityInput,
  workingLocationSchema,
} from "./schemas.js";
import { parseTimeInput } from "./time.js";

const args = z.object({
  summary: z.string().max(8192),
  startTime: z.string().max(64),
  endTime: z.string().max(64),
  attendeeEmails: z.array(email).max(500).optional(),
  attendees: z.array(attendeeArg).max(500).optional(),
  recurrenceData: z.array(z.string().regex(/^(RRULE|EXRULE|RDATE|EXDATE)[:;][^\r\n]+$/, "Must be an RRULE, EXRULE, RDATE or EXDATE line")).max(100).optional(),
  overrideReminders: z.array(reminderArg).max(5).optional(),
  attachments: z.array(attachmentArg).max(25).optional(),
  calendarId: calendarId.optional(),
  description: z.string().max(65536).optional(),
  location: z.string().max(8192).optional(),
  allDay: z.boolean().optional(),
  timeZone: timeZoneArg.optional(),
  notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
  addGoogleMeetUrl: z.boolean().optional(),
  visibility: visibilityArg.optional(),
  colorId: colorIdArg.optional(),
  googleMeetUrl: z.string().max(2048).optional(),
  guestPermissions: guestPermissionsArg.optional(),
  availability: z.enum(AVAILABILITIES).optional(),
  eventType: z.enum(EVENT_TYPES).optional(),
  workingLocationProperties: workingLocationArg.optional(),
  useDefaultReminders: z.boolean().optional(),
});
export type CreateEventArgs = z.infer<typeof args>;

export function mergedAttendees(input: Pick<CreateEventArgs, "attendees" | "attendeeEmails">): RestAttendee[] {
  const seen = new Set<string>();
  const result: RestAttendee[] = [];
  for (const attendee of [...(input.attendees ?? []), ...(input.attendeeEmails ?? []).map((value) => ({ email: value }))]) {
    const key = attendee.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(restAttendee(attendee));
  }
  return result;
}

export function needsTimeZone(input: CreateEventArgs): boolean {
  return !input.allDay && !input.timeZone;
}

export function eventTimes(input: Pick<CreateEventArgs, "startTime" | "endTime" | "allDay">, timeZone: string | undefined): { start: RestDateTime; end: RestDateTime } {
  if (input.allDay) return allDayTimes(input.startTime, input.endTime);
  if (!timeZone) throw new GoogleToolError("invalid_argument", "A time zone is needed for a timed event.");
  return timedTimes(input.startTime, input.endTime, timeZone);
}

export function createEventRequest(input: CreateEventArgs, timeZone: string | undefined, requestId: string): GoogleRequest {
  if (input.eventType === "FROM_GMAIL") throw new GoogleToolError("invalid_argument", "Events of type FROM_GMAIL cannot be created.");
  const attendees = mergedAttendees(input);
  const conferenceData = conferenceBody(input.addGoogleMeetUrl, input.googleMeetUrl, requestId);
  const body: RestEvent = compact({
    summary: input.summary,
    description: input.description,
    location: input.location,
    ...eventTimes(input, timeZone),
    recurrence: input.recurrenceData?.length ? input.recurrenceData : undefined,
    attendees: attendees.length ? attendees : undefined,
    reminders: remindersBody(input.overrideReminders, input.useDefaultReminders),
    attachments: input.attachments?.length ? input.attachments.map((item) => compact({ fileUrl: item.fileUrl, title: item.title })) : undefined,
    visibility: input.visibility,
    colorId: input.colorId,
    conferenceData,
    ...guestPermissionsBody(input.guestPermissions),
    transparency: restTransparency(input.availability),
    eventType: input.eventType ? restEventType(input.eventType) : undefined,
    workingLocationProperties: workingLocationBody(input.workingLocationProperties),
  });
  return {
    method: "POST",
    host: CALENDAR_HOST,
    path: eventsPath(input.calendarId),
    query: {
      sendUpdates: sendUpdates(input.notificationLevel, "ALL"),
      conferenceDataVersion: conferenceData ? 1 : undefined,
      supportsAttachments: input.attachments?.length ? true : undefined,
    },
    body,
  };
}

export function createEventResult(event: RestEvent): CallToolResult {
  return structuredResult(toMcpEvent(event));
}

export const createEvent = defineTool({
  definition: {
    name: "create_event",
    title: "Create an event",
    description: "Creates an event on a calendar and returns it. By default Google emails an invitation to every attendee (notificationLevel ALL); pass notificationLevel NONE to create it silently.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Required. Title." },
        startTime: { type: "string", description: `Required. Start (ISO 8601, for example 2026-04-30T10:00:00). ${TIME_RULES}` },
        endTime: { type: "string", description: `Required. End (ISO 8601, for example 2026-04-30T11:00:00), after startTime. Same rules as startTime. For an all-day event the end is exclusive: a one-day event on April 30 ends 2026-05-01.` },
        attendeeEmails: { type: "array", items: { type: "string" }, description: "Deprecated: use attendees." },
        attendees: { type: "array", items: attendeeSchema, description: "Optional. Attendees." },
        recurrenceData: { type: "array", items: { type: "string" }, description: "Optional. RRULE, RDATE or EXDATE lines (RFC 5545), for example RRULE:FREQ=WEEKLY;COUNT=10." },
        overrideReminders: { type: "array", items: reminderSchema, description: "Optional. Reminders that replace the calendar's defaults, at most 5." },
        attachments: { type: "array", items: attachmentSchema, description: "Optional. File attachments, as Google Drive file links." },
        calendarId: calendarIdInput,
        description: { type: "string", description: "Optional. Description. Can contain HTML." },
        location: { type: "string", description: "Optional. Location." },
        allDay: { type: "boolean", description: "Optional. Whether the event takes whole days. When true, only the dates of startTime and endTime are used." },
        timeZone: timeZoneInput("the event is created in."),
        notificationLevel: notificationLevelInput("ALL"),
        addGoogleMeetUrl: { type: "boolean", description: "Optional. Create a Google Meet link for the event. Default: false." },
        visibility: visibilityInput,
        colorId: colorIdInput,
        googleMeetUrl: { type: "string", description: "Optional. An existing Google Meet link or meeting ID to attach. Overrides addGoogleMeetUrl." },
        guestPermissions: { ...guestPermissionsSchema, description: "Optional. Guest permissions." },
        availability: availabilityInput,
        eventType: eventTypeInput,
        workingLocationProperties: { ...workingLocationSchema, description: "Optional. Working location details, for WORKING_LOCATION events." },
        useDefaultReminders: { type: "boolean", description: "Optional. Whether the calendar's default reminders apply. Cannot be true with overrideReminders. False with no overrideReminders means no reminders." },
      },
      required: ["summary", "startTime", "endTime"],
    },
    outputSchema: eventSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  args,
  async run(input, http) {
    assertTimeZone(input.timeZone);
    parseTimeInput(input.startTime, "startTime");
    parseTimeInput(input.endTime, "endTime");
    const timeZone = input.timeZone ?? (needsTimeZone(input) ? await calendarTimeZone(input.calendarId, http) : undefined);
    const request = createEventRequest(input, timeZone, randomUUID());
    return createEventResult(await http.send<RestEvent>(request));
  },
});
