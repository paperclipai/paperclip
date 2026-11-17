import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import {
  allDayEnd,
  attachmentArg,
  attendeeArg,
  colorIdArg,
  conferenceBody,
  email,
  guestPermissionsArg,
  guestPermissionsBody,
  reminderArg,
  remindersBody,
  restAttendee,
  timedTime,
  visibilityArg,
} from "./event-input.js";
import {
  assertTimeZone,
  AVAILABILITIES,
  CALENDAR_HOST,
  calendarId,
  calendarTimeZone,
  eventId,
  eventPath,
  getEventRequest,
  NOTIFICATION_LEVELS,
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
  guestPermissionsSchema,
  notificationLevelInput,
  reminderSchema,
  TIME_RULES,
  timeZoneInput,
  visibilityInput,
} from "./schemas.js";
import { addDays, daysBetween, formatDate, instantOf, parseTimeInput } from "./time.js";

const args = z.object({
  eventId,
  addedAttendeeEmails: z.array(email).max(500).optional(),
  addedAttendees: z.array(attendeeArg).max(500).optional(),
  removedAttendeeEmails: z.array(email).max(500).optional(),
  overrideReminders: z.array(reminderArg).max(5).optional(),
  addedAttachments: z.array(attachmentArg).max(25).optional(),
  removedAttachmentFileUrls: z.array(z.string().max(2048)).max(25).optional(),
  calendarId: calendarId.optional(),
  summary: z.string().max(8192).optional(),
  description: z.string().max(65536).optional(),
  location: z.string().max(8192).optional(),
  startTime: z.string().max(64).optional(),
  endTime: z.string().max(64).optional(),
  allDay: z.boolean().optional(),
  timeZone: timeZoneArg.optional(),
  notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
  addGoogleMeetUrl: z.boolean().optional(),
  visibility: visibilityArg.optional(),
  colorId: colorIdArg.optional(),
  googleMeetUrl: z.string().max(2048).optional(),
  guestPermissions: guestPermissionsArg.optional(),
  availability: z.enum(AVAILABILITIES).optional(),
  useDefaultReminders: z.boolean().optional(),
});
export type UpdateEventArgs = z.infer<typeof args>;

interface TimeChange { start: RestDateTime; end: RestDateTime }

const isAllDay = (event: RestEvent) => Boolean(event.start?.date);
const touchesTimes = (input: UpdateEventArgs) =>
  input.startTime !== undefined || input.endTime !== undefined || input.allDay !== undefined || input.timeZone !== undefined;

export function updateNeedsTimeZone(input: UpdateEventArgs, current: RestEvent): boolean {
  if (!touchesTimes(input) || input.timeZone || current.start?.timeZone) return false;
  return !(input.allDay ?? isAllDay(current));
}

function instantOfCurrent(value: RestDateTime | undefined, field: string): number {
  const parsed = value?.dateTime ? Date.parse(value.dateTime) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new GoogleToolError("invalid_response", `The event's current ${field} could not be read.`);
  return parsed;
}

export function updatedTimes(input: UpdateEventArgs, current: RestEvent, timeZone: string | undefined): TimeChange | undefined {
  if (!touchesTimes(input)) return undefined;
  if (input.allDay !== undefined && (input.startTime === undefined || input.endTime === undefined)) {
    throw new GoogleToolError("invalid_argument", "When allDay is set, startTime and endTime must both be given.");
  }
  const allDay = input.allDay ?? isAllDay(current);
  if (allDay) {
    if (input.startTime === undefined && input.endTime === undefined) return undefined;
    const currentStart = current.start?.date ? parseTimeInput(current.start.date) : undefined;
    const currentEnd = current.end?.date ? parseTimeInput(current.end.date) : undefined;
    const start = input.startTime !== undefined ? parseTimeInput(input.startTime, "startTime") : currentStart!;
    let end: string;
    if (input.endTime !== undefined) end = allDayEnd(start, parseTimeInput(input.endTime, "endTime"));
    else {
      const days = currentStart && currentEnd ? Math.max(1, daysBetween(currentStart.date, currentEnd.date)) : 1;
      end = formatDate(addDays(start.date, days));
    }
    return {
      start: { date: formatDate(start.date), dateTime: null, timeZone: null },
      end: { date: end, dateTime: null, timeZone: null },
    };
  }
  if (!timeZone) throw new GoogleToolError("invalid_argument", "A time zone is needed to change the event's times.");
  const read = (value: string, field: string) => instantOf(parseTimeInput(value, field), timeZone);
  let start: number;
  let end: number;
  if (input.startTime !== undefined && input.endTime !== undefined) {
    start = read(input.startTime, "startTime");
    end = read(input.endTime, "endTime");
  } else if (input.startTime !== undefined) {
    start = read(input.startTime, "startTime");
    end = start + (instantOfCurrent(current.end, "end") - instantOfCurrent(current.start, "start"));
  } else if (input.endTime !== undefined) {
    start = instantOfCurrent(current.start, "start");
    end = read(input.endTime, "endTime");
  } else {
    start = instantOfCurrent(current.start, "start");
    end = instantOfCurrent(current.end, "end");
  }
  if (end <= start) throw new GoogleToolError("invalid_argument", "endTime must be after startTime.");
  return {
    start: { ...timedTime(start, timeZone), date: null },
    end: { ...timedTime(end, timeZone), date: null },
  };
}

export function updatedAttendees(input: UpdateEventArgs, current: RestEvent): RestAttendee[] | undefined {
  const added = [...(input.addedAttendees ?? []), ...(input.addedAttendeeEmails ?? []).map((value) => ({ email: value }))];
  const removed = new Set((input.removedAttendeeEmails ?? []).map((value) => value.toLowerCase()));
  if (!added.length && !removed.size) return undefined;
  const result = (current.attendees ?? []).filter((attendee) => !removed.has((attendee.email ?? "").toLowerCase()));
  for (const attendee of added) {
    const key = attendee.email.toLowerCase();
    if (removed.has(key)) continue;
    const index = result.findIndex((existing) => (existing.email ?? "").toLowerCase() === key);
    const next = restAttendee(attendee);
    if (index === -1) result.push(next);
    else result[index] = { ...result[index], ...next };
  }
  return result;
}

export function updatedAttachments(input: UpdateEventArgs, current: RestEvent): RestEvent["attachments"] | undefined {
  const removed = new Set(input.removedAttachmentFileUrls ?? []);
  const added = input.addedAttachments ?? [];
  if (!added.length && !removed.size) return undefined;
  const result = (current.attachments ?? []).filter((item) => !removed.has(item.fileUrl ?? ""));
  for (const item of added) {
    if (!result.some((existing) => existing.fileUrl === item.fileUrl)) result.push(compact({ fileUrl: item.fileUrl, title: item.title }));
  }
  return result;
}

export function updateEventPatch(input: UpdateEventArgs, current: RestEvent, timeZone: string | undefined, requestId: string): { body: Record<string, unknown>; query: Record<string, string | number | boolean | undefined> } {
  const conferenceData = conferenceBody(input.addGoogleMeetUrl, input.googleMeetUrl, requestId);
  const attachments = updatedAttachments(input, current);
  const body = compact({
    summary: input.summary,
    description: input.description,
    location: input.location,
    ...(updatedTimes(input, current, timeZone) ?? {}),
    attendees: updatedAttendees(input, current),
    reminders: remindersBody(input.overrideReminders, input.useDefaultReminders),
    attachments,
    visibility: input.visibility,
    colorId: input.colorId,
    conferenceData,
    ...guestPermissionsBody(input.guestPermissions),
    transparency: restTransparency(input.availability),
  });
  return {
    body,
    query: {
      sendUpdates: sendUpdates(input.notificationLevel, "ALL"),
      conferenceDataVersion: conferenceData ? 1 : undefined,
      supportsAttachments: attachments ? true : undefined,
    },
  };
}

export function updateEventRequest(input: UpdateEventArgs, current: RestEvent, timeZone: string | undefined, requestId: string): GoogleRequest | undefined {
  const { body, query } = updateEventPatch(input, current, timeZone, requestId);
  if (Object.keys(body).length === 0) return undefined;
  return { method: "PATCH", host: CALENDAR_HOST, path: eventPath(input.calendarId, input.eventId), query, body, ifMatch: current.etag };
}

export function updateEventResult(event: RestEvent): CallToolResult {
  return structuredResult(toMcpEvent(event));
}

export const updateEvent = defineTool({
  definition: {
    name: "update_event",
    description: "Changes an event on a calendar and returns the updated event. Fields that are not set are left as they are. By default Google emails the change to every attendee (notificationLevel ALL); pass notificationLevel NONE to change it silently. Passing a recurring series' ID changes the whole series (every occurrence that has not been changed on its own); passing one occurrence's ID (from list_events) changes only that occurrence. The result shows which: a series has recurrence and no recurringEventId; one occurrence has recurringEventId.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Required. Event ID, from list_events or search_events." },
        addedAttendeeEmails: { type: "array", items: { type: "string" }, description: "Deprecated: use addedAttendees." },
        addedAttendees: { type: "array", items: attendeeSchema, description: "Optional. Attendees to add." },
        removedAttendeeEmails: { type: "array", items: { type: "string" }, description: "Optional. Email addresses of attendees to remove." },
        overrideReminders: { type: "array", items: reminderSchema, description: "Optional. When set, replaces all of the event's reminders." },
        addedAttachments: { type: "array", items: attachmentSchema, description: "Optional. File attachments to add, as Google Drive file links." },
        removedAttachmentFileUrls: { type: "array", items: { type: "string" }, description: "Optional. Links of attachments to remove." },
        calendarId: calendarIdInput,
        summary: { type: "string", description: "Optional. New title." },
        description: { type: "string", description: "Optional. New description. Can contain HTML." },
        location: { type: "string", description: "Optional. New location." },
        startTime: { type: "string", description: `Optional. New start (ISO 8601). When only the start changes, the duration is kept. ${TIME_RULES}` },
        endTime: { type: "string", description: "Optional. New end (ISO 8601). Same rules as startTime. For an all-day event the end is exclusive." },
        allDay: { type: "boolean", description: "Optional. Makes the event all-day (true) or timed (false). When set, startTime and endTime are required." },
        timeZone: timeZoneInput("for the event. Given alone, the event keeps the same moment in time and is shown in this time zone."),
        notificationLevel: notificationLevelInput("ALL"),
        addGoogleMeetUrl: { type: "boolean", description: "Optional. When true, creates a Google Meet link for the event." },
        visibility: visibilityInput,
        colorId: colorIdInput,
        googleMeetUrl: { type: "string", description: "Optional. An existing Google Meet link or meeting ID to attach. Overrides addGoogleMeetUrl." },
        guestPermissions: { ...guestPermissionsSchema, description: "Optional. Guest permissions." },
        availability: availabilityInput,
        useDefaultReminders: { type: "boolean", description: "Optional. When true, the calendar's default reminders apply and override reminders are cleared. Cannot be true with overrideReminders. False with no overrideReminders removes all reminders." },
      },
      required: ["eventId"],
    },
    outputSchema: eventSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    assertTimeZone(input.timeZone);
    if (input.startTime !== undefined) parseTimeInput(input.startTime, "startTime");
    if (input.endTime !== undefined) parseTimeInput(input.endTime, "endTime");
    const current = await http.send<RestEvent>(getEventRequest(input.calendarId, input.eventId));
    const eventZone = current.start?.timeZone || undefined;
    const timeZone = input.timeZone ?? eventZone
      ?? (updateNeedsTimeZone(input, current) ? await calendarTimeZone(input.calendarId, http) : undefined);
    const request = updateEventRequest(input, current, timeZone, randomUUID());
    if (!request) return updateEventResult(current);
    return updateEventResult(await http.send<RestEvent>(request));
  },
});
