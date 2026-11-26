import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import { compact } from "../tool.js";
import type { RestAttendee, RestConferenceData, RestDateTime, RestReminder, RestWorkingLocation } from "./event.js";
import { WORKING_LOCATION_TYPES } from "./schemas.js";
import { addDays, compareDates, formatDate, formatInZone, instantOf, parseTimeInput, type TimeInput } from "./time.js";

export const email = z.string().max(320).regex(/^[^\s<>@,;"()\\]+@[^\s<>@,;"()\\]+$/, "Must be a plain email address such as user@example.com");

export const attendeeArg = z.object({
  id: z.string().optional(),
  email,
  displayName: z.string().max(1024).optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
  resource: z.boolean().optional(),
  optionalAttendee: z.boolean().optional(),
  responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional(),
  comment: z.string().optional(),
  additionalGuests: z.number().int().min(0).max(100).optional(),
});
export type AttendeeArg = z.infer<typeof attendeeArg>;

export const reminderArg = z.object({ method: z.enum(["email", "popup"]), minutes: z.number().int().min(0).max(40320) });
export const attachmentArg = z.object({ fileUrl: z.string().url().max(2048), title: z.string().max(1024).optional() });
export const guestPermissionsArg = z.object({
  guestsCanInviteOthers: z.boolean().optional(),
  guestsCanModify: z.boolean().optional(),
  guestsCanSeeGuests: z.boolean().optional(),
});
export const visibilityArg = z.enum(["default", "public", "private"]);
export const colorIdArg = z.string().regex(/^([1-9]|1[01])$/, "Must be a color ID from \"1\" to \"11\"");
export const workingLocationArg = z.object({
  type: z.enum(WORKING_LOCATION_TYPES).optional(),
  customLocationLabel: z.string().max(1024).optional(),
  officeLocation: z.object({
    buildingId: z.string().optional(),
    floorId: z.string().optional(),
    floorSectionId: z.string().optional(),
    deskId: z.string().optional(),
    label: z.string().optional(),
  }).optional(),
  timeZone: z.string().optional(),
});

export function restAttendee(input: AttendeeArg): RestAttendee {
  return compact({
    email: input.email,
    displayName: input.displayName,
    optional: input.optionalAttendee,
    resource: input.resource,
    responseStatus: input.responseStatus,
    additionalGuests: input.additionalGuests,
  });
}

export function remindersBody(overrides: RestReminder[] | undefined, useDefault: boolean | undefined): { useDefault: boolean; overrides?: RestReminder[] } | undefined {
  if (useDefault === true && overrides?.length) throw new GoogleToolError("invalid_argument", "useDefaultReminders cannot be true when overrideReminders are given.");
  if (overrides !== undefined) return { useDefault: false, overrides: overrides.map((item) => ({ method: item.method, minutes: item.minutes })) };
  if (useDefault === true) return { useDefault: true, overrides: [] };
  if (useDefault === false) return { useDefault: false, overrides: [] };
  return undefined;
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export function meetCode(value: string): string {
  const trimmed = value.trim();
  const fromUrl = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/.exec(trimmed)?.[1];
  const code = fromUrl ?? trimmed;
  if (!MEET_CODE.test(code)) throw new GoogleToolError("invalid_argument", "googleMeetUrl must be a Google Meet link such as https://meet.google.com/abc-defg-hij, or its meeting ID.");
  return code;
}

export function conferenceBody(addGoogleMeetUrl: boolean | undefined, googleMeetUrl: string | undefined, requestId: string): RestConferenceData | undefined {
  if (googleMeetUrl) {
    const code = meetCode(googleMeetUrl);
    return {
      conferenceId: code,
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [{ entryPointType: "video", uri: `https://meet.google.com/${code}` }],
    };
  }
  if (addGoogleMeetUrl) return { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return undefined;
}

export function guestPermissionsBody(input: z.infer<typeof guestPermissionsArg> | undefined) {
  if (!input) return {};
  return compact({
    guestsCanInviteOthers: input.guestsCanInviteOthers,
    guestsCanModify: input.guestsCanModify,
    guestsCanSeeOtherGuests: input.guestsCanSeeGuests,
  });
}

export function workingLocationBody(input: z.infer<typeof workingLocationArg> | undefined): RestWorkingLocation | undefined {
  if (!input) return undefined;
  if (input.type === "CUSTOM_LOCATION") return { type: "customLocation", customLocation: compact({ label: input.customLocationLabel }) };
  if (input.type === "OFFICE_LOCATION") return { type: "officeLocation", officeLocation: compact({ ...(input.officeLocation ?? {}) }) };
  return { type: "homeOffice", homeOffice: {} };
}

export function allDayEnd(start: TimeInput, end: TimeInput): string {
  if (compareDates(end.date, start.date) < 0) throw new GoogleToolError("invalid_argument", "endTime must not be before startTime.");
  const roundedUp = end.time && (end.time.hour || end.time.minute || end.time.second || end.time.millisecond) ? addDays(end.date, 1) : end.date;
  return formatDate(compareDates(roundedUp, start.date) > 0 ? roundedUp : addDays(start.date, 1));
}

export function allDayTimes(startTime: string, endTime: string): { start: RestDateTime; end: RestDateTime } {
  const start = parseTimeInput(startTime, "startTime");
  const end = parseTimeInput(endTime, "endTime");
  return { start: { date: formatDate(start.date) }, end: { date: allDayEnd(start, end) } };
}

export function timedTime(instant: number, timeZone: string): RestDateTime {
  return { dateTime: formatInZone(instant, timeZone), timeZone };
}

export function timedTimes(startTime: string, endTime: string, timeZone: string): { start: RestDateTime; end: RestDateTime } {
  const start = instantOf(parseTimeInput(startTime, "startTime"), timeZone);
  const end = instantOf(parseTimeInput(endTime, "endTime"), timeZone);
  if (end <= start) throw new GoogleToolError("invalid_argument", "endTime must be after startTime.");
  return { start: timedTime(start, timeZone), end: timedTime(end, timeZone) };
}
