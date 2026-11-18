import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact } from "../tool.js";
import { isValidTimeZone } from "./time.js";

export const CALENDAR_HOST = "www.googleapis.com" as const;
export const CALENDAR_BASE = "/calendar/v3";

export const calendarId = z.string()
  .regex(/^[^\s/\\?%\u0000-\u001f]{1,1024}$/, "Must be a calendar ID such as primary or an email address")
  .refine((value) => value !== "." && value !== "..", "Must be a calendar ID such as primary or an email address");
export const eventId = z.string().regex(/^[A-Za-z0-9_@.-]{1,1024}$/, "Must be a Calendar event ID")
  .refine((value) => value !== "." && value !== "..", "Must be a Calendar event ID");
export const timeZoneArg = z.string().min(1).max(64);

export function eventsPath(calendar: string | undefined): string {
  return `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendar ?? "primary")}/events`;
}

export function eventPath(calendar: string | undefined, event: string): string {
  return `${eventsPath(calendar)}/${encodeURIComponent(event)}`;
}

export interface RestDateTime { date?: string | null; dateTime?: string | null; timeZone?: string | null }
export interface RestPrincipal { id?: string; email?: string; displayName?: string; self?: boolean }
export interface RestAttendee {
  id?: string; email?: string; displayName?: string; organizer?: boolean; self?: boolean; resource?: boolean;
  optional?: boolean; responseStatus?: string; comment?: string; additionalGuests?: number;
}
export interface RestReminder { method?: string; minutes?: number }
export interface RestEntryPoint {
  entryPointType?: string; uri?: string; label?: string; pin?: string; accessCode?: string; meetingCode?: string;
  passcode?: string; password?: string; regionCode?: string;
}
export interface RestConferenceData {
  conferenceId?: string;
  conferenceSolution?: { name?: string; key?: { type?: string } };
  entryPoints?: RestEntryPoint[];
  notes?: string;
  createRequest?: unknown;
}
export interface RestWorkingLocation {
  type?: string;
  homeOffice?: unknown;
  customLocation?: { label?: string };
  officeLocation?: { buildingId?: string; floorId?: string; floorSectionId?: string; deskId?: string; label?: string };
}
export interface RestEvent {
  id?: string; etag?: string; status?: string; htmlLink?: string; created?: string; updated?: string;
  summary?: string; description?: string; location?: string; colorId?: string;
  creator?: RestPrincipal; organizer?: RestPrincipal;
  start?: RestDateTime; end?: RestDateTime; originalStartTime?: RestDateTime;
  recurrence?: string[]; recurringEventId?: string;
  transparency?: string; visibility?: string;
  attendees?: RestAttendee[];
  hangoutLink?: string;
  conferenceData?: RestConferenceData;
  reminders?: { useDefault?: boolean; overrides?: RestReminder[] };
  attachments?: Array<{ fileUrl?: string; title?: string }>;
  guestsCanInviteOthers?: boolean; guestsCanModify?: boolean; guestsCanSeeOtherGuests?: boolean;
  eventType?: string;
  workingLocationProperties?: RestWorkingLocation;
}
export interface RestEventList {
  summary?: string; description?: string; updated?: string; timeZone?: string; accessRole?: string;
  defaultReminders?: RestReminder[]; items?: RestEvent[]; nextPageToken?: string;
}

export const EVENT_TYPES = ["EVENT_TYPE_UNSPECIFIED", "DEFAULT", "OUT_OF_OFFICE", "FOCUS_TIME", "WORKING_LOCATION", "BIRTHDAY", "FROM_GMAIL"] as const;
export type McpEventType = (typeof EVENT_TYPES)[number];
const EVENT_TYPE_TO_REST: Record<McpEventType, string> = {
  EVENT_TYPE_UNSPECIFIED: "default", DEFAULT: "default", OUT_OF_OFFICE: "outOfOffice", FOCUS_TIME: "focusTime",
  WORKING_LOCATION: "workingLocation", BIRTHDAY: "birthday", FROM_GMAIL: "fromGmail",
};
const EVENT_TYPE_FROM_REST: Record<string, McpEventType> = {
  default: "DEFAULT", outOfOffice: "OUT_OF_OFFICE", focusTime: "FOCUS_TIME", workingLocation: "WORKING_LOCATION",
  birthday: "BIRTHDAY", fromGmail: "FROM_GMAIL",
};
export const restEventType = (type: McpEventType) => EVENT_TYPE_TO_REST[type];

export const AVAILABILITIES = ["AVAILABILITY_UNSPECIFIED", "AVAILABILITY_BUSY", "AVAILABILITY_FREE"] as const;
export type Availability = (typeof AVAILABILITIES)[number];
export function restTransparency(availability: Availability | undefined): string | undefined {
  if (availability === "AVAILABILITY_FREE") return "transparent";
  if (availability === "AVAILABILITY_BUSY") return "opaque";
  return undefined;
}

export const NOTIFICATION_LEVELS = ["NOTIFICATION_LEVEL_UNSPECIFIED", "NONE", "EXTERNAL_ONLY", "ALL"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];
export function sendUpdates(level: NotificationLevel | undefined, fallback: Exclude<NotificationLevel, "NOTIFICATION_LEVEL_UNSPECIFIED">): string {
  const effective = !level || level === "NOTIFICATION_LEVEL_UNSPECIFIED" ? fallback : level;
  return effective === "NONE" ? "none" : effective === "EXTERNAL_ONLY" ? "externalOnly" : "all";
}

const WORKING_LOCATION_TYPE_FROM_REST: Record<string, string> = {
  homeOffice: "HOME_OFFICE", customLocation: "CUSTOM_LOCATION", officeLocation: "OFFICE_LOCATION",
};

function principal(value: RestPrincipal | undefined) {
  return value ? compact({ email: value.email, displayName: value.displayName, self: value.self }) : undefined;
}

function dateOrDateTime(value: RestDateTime | undefined) {
  return value ? compact({ date: value.date ?? undefined, dateTime: value.dateTime ?? undefined, timeZone: value.timeZone ?? undefined }) : undefined;
}

export function toMcpAttendee(value: RestAttendee) {
  return compact({
    id: value.id, email: value.email, displayName: value.displayName, organizer: value.organizer, self: value.self,
    resource: value.resource, optionalAttendee: value.optional, responseStatus: value.responseStatus,
    comment: value.comment, additionalGuests: value.additionalGuests,
  });
}

const CODE_FIELDS = [["accessCode", "ACCESS_CODE"], ["passcode", "PASSCODE"], ["password", "PASSWORD"], ["meetingCode", "MEETING_CODE"], ["pin", "PIN"]] as const;

function entryPoint(value: RestEntryPoint | undefined) {
  if (!value) return undefined;
  const codes = CODE_FIELDS.flatMap(([field, codeType]) => (value[field] ? [{ codeType, value: value[field]! }] : []));
  return compact({ uri: value.uri, codes: codes.length ? codes : undefined });
}

function conferenceData(value: RestConferenceData | undefined) {
  if (!value?.entryPoints?.length && !value?.conferenceSolution) return undefined;
  const points = value.entryPoints ?? [];
  const byType = (type: string) => points.find((point) => point.entryPointType === type);
  const phones = points.filter((point) => point.entryPointType === "phone").map((point) => {
    const codes = CODE_FIELDS.flatMap(([field, codeType]) => (point[field] ? [{ codeType, value: point[field]! }] : []));
    return compact({
      phoneNumber: point.label ?? point.uri?.replace(/^tel:/, ""),
      codes: codes.length ? codes : undefined,
      regionCode: point.regionCode,
    });
  });
  return compact({
    solutionName: value.conferenceSolution?.name,
    joiningNotesText: value.notes,
    videoEntryPoint: entryPoint(byType("video")),
    phoneEntryPoints: phones.length ? phones : undefined,
    sipEntryPoint: entryPoint(byType("sip")),
    moreDetailsEntryPoint: entryPoint(byType("more")),
  });
}

function workingLocation(value: RestWorkingLocation | undefined) {
  if (!value) return undefined;
  return compact({
    type: value.type ? WORKING_LOCATION_TYPE_FROM_REST[value.type] ?? "WORKING_LOCATION_TYPE_UNSPECIFIED" : undefined,
    customLocationLabel: value.customLocation?.label,
    officeLocation: value.officeLocation ? compact({ ...value.officeLocation }) : undefined,
  });
}

export function toMcpEvent(event: RestEvent): Record<string, unknown> {
  const guestPermissions = compact({
    guestsCanInviteOthers: event.guestsCanInviteOthers, guestsCanModify: event.guestsCanModify, guestsCanSeeGuests: event.guestsCanSeeOtherGuests,
  });
  const conference = conferenceData(event.conferenceData);
  return compact({
    id: event.id ?? "",
    status: event.status,
    htmlLink: event.htmlLink,
    created: event.created,
    updated: event.updated,
    summary: event.summary,
    description: event.description,
    location: event.location,
    creator: principal(event.creator),
    organizer: principal(event.organizer),
    start: dateOrDateTime(event.start),
    end: dateOrDateTime(event.end),
    recurrence: event.recurrence?.length ? event.recurrence : undefined,
    recurringEventId: event.recurringEventId,
    originalStartTime: dateOrDateTime(event.originalStartTime),
    transparency: event.transparency,
    visibility: event.visibility,
    attendees: event.attendees?.length ? event.attendees.map(toMcpAttendee) : undefined,
    conferenceUrl: event.hangoutLink ?? (conference?.videoEntryPoint as { uri?: string } | undefined)?.uri,
    conferenceData: conference,
    colorId: event.colorId,
    overrideReminders: event.reminders?.overrides?.length ? event.reminders.overrides.map((item) => compact({ method: item.method, minutes: item.minutes })) : undefined,
    attachments: event.attachments?.length ? event.attachments.map((item) => compact({ fileUrl: item.fileUrl, title: item.title })) : undefined,
    guestPermissions: Object.keys(guestPermissions).length ? guestPermissions : undefined,
    eventType: event.eventType ? EVENT_TYPE_FROM_REST[event.eventType] ?? "EVENT_TYPE_UNSPECIFIED" : undefined,
    workingLocationProperties: workingLocation(event.workingLocationProperties),
    availability: event.transparency === "transparent" ? "AVAILABILITY_FREE" : "AVAILABILITY_BUSY",
    useDefaultReminders: event.reminders?.useDefault,
  });
}

export function getEventRequest(calendar: string | undefined, event: string): GoogleRequest {
  return { method: "GET", host: CALENDAR_HOST, path: eventPath(calendar, event) };
}

export function calendarTimeZoneRequest(calendar: string | undefined): GoogleRequest {
  return { method: "GET", host: CALENDAR_HOST, path: eventsPath(calendar), query: { maxResults: 1, fields: "timeZone" } };
}

export async function calendarTimeZone(calendar: string | undefined, http: GoogleHttp): Promise<string> {
  const answer = await http.send<{ timeZone?: string }>(calendarTimeZoneRequest(calendar));
  if (!answer.timeZone) throw new GoogleToolError("invalid_response", "Could not read the calendar's time zone. Pass timeZone.");
  return answer.timeZone;
}

export function assertTimeZone(timeZone: string | undefined): void {
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
    throw new GoogleToolError("invalid_argument", `timeZone must be an IANA time zone name such as America/Los_Angeles, not ${JSON.stringify(timeZone)}.`);
  }
}