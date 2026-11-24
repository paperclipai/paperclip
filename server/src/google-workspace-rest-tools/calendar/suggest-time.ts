import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError, GoogleWorkspaceAuthError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import { assertTimeZone, CALENDAR_BASE, CALENDAR_HOST, calendarTimeZone, eventsPath, timeZoneArg, type RestEvent } from "./event.js";
import { TIME_RULES, timeZoneInput } from "./schemas.js";
import {
  addDays,
  compareDates,
  formatInZone,
  instantOf,
  localDateAt,
  parseTimeInput,
  weekday,
  zonedToInstant,
  type CivilDate,
} from "./time.js";

export const DEFAULT_DURATION_MINUTES = 30;
export const DEFAULT_SLOT_COUNT = 5;
export const MAX_SLOT_COUNT = 50;
export const MAX_ATTENDEES = 50;
export const MAX_RANGE_DAYS = 62;
export const MAX_EVENT_PAGES = 10;
const MINUTE = 60_000;

const hourOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Must be HH:mm, 24-hour");
const plainEmail = z.string().regex(/^[^\s<>@,;"()\\/?#%]+@[^\s<>@,;"()\\/?#%]+$/, "Must be an email address");

const args = z.object({
  attendeeEmails: z.array(plainEmail).min(1).max(MAX_ATTENDEES),
  startTime: z.string().max(64),
  endTime: z.string().max(64),
  timeZone: timeZoneArg.optional(),
  durationMinutes: z.number().int().positive().max(MAX_RANGE_DAYS * 24 * 60).optional(),
  preferences: z.object({
    startHour: hourOfDay.optional(),
    endHour: hourOfDay.optional(),
    excludeWeekends: z.boolean().optional(),
    pageSize: z.number().int().positive().optional(),
  }).optional(),
});
export type SuggestTimeArgs = z.infer<typeof args>;
export type Preferences = NonNullable<SuggestTimeArgs["preferences"]>;

export interface Interval { start: number; end: number }

export function suggestRange(input: SuggestTimeArgs, timeZone: string): Interval {
  const start = instantOf(parseTimeInput(input.startTime, "startTime"), timeZone);
  const end = instantOf(parseTimeInput(input.endTime, "endTime"), timeZone);
  if (end <= start) throw new GoogleToolError("invalid_argument", "endTime must be after startTime.");
  if (end - start > MAX_RANGE_DAYS * 1440 * MINUTE) throw new GoogleToolError("invalid_argument", `The search range can be at most ${MAX_RANGE_DAYS} days.`);
  return { start, end };
}

export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((item) => item.end > item.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

export function freeIntervals(range: Interval, busy: readonly Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = range.start;
  for (const item of mergeIntervals(busy)) {
    if (item.end <= cursor) continue;
    if (item.start >= range.end) break;
    if (item.start > cursor) free.push({ start: cursor, end: item.start });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < range.end) free.push({ start: cursor, end: range.end });
  return free;
}

function minuteOfDay(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: hour!, minute: minute! };
}

function atMinute(date: CivilDate, value: { hour: number; minute: number }, timeZone: string): number {
  if (value.hour === 24) return zonedToInstant(addDays(date, 1), { hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone);
  return zonedToInstant(date, { hour: value.hour, minute: value.minute, second: 0, millisecond: 0 }, timeZone);
}

export function allowedWindows(range: Interval, timeZone: string, preferences: Preferences = {}): Interval[] {
  const { startHour, endHour, excludeWeekends } = preferences;
  if (!startHour && !endHour && !excludeWeekends) return [range];
  const from = minuteOfDay(startHour ?? "00:00");
  const to = minuteOfDay(endHour ?? "24:00");
  if (to.hour * 60 + to.minute <= from.hour * 60 + from.minute) {
    throw new GoogleToolError("invalid_argument", "preferences.endHour must be later than preferences.startHour on the same day.");
  }
  const windows: Interval[] = [];
  const last = localDateAt(range.end, timeZone);
  for (let day = addDays(localDateAt(range.start, timeZone), -1); compareDates(day, last) <= 0; day = addDays(day, 1)) {
    if (excludeWeekends && [0, 6].includes(weekday(day))) continue;
    const start = Math.max(range.start, atMinute(day, from, timeZone));
    const end = Math.min(range.end, atMinute(day, to, timeZone));
    if (end > start) windows.push({ start, end });
  }
  return mergeIntervals(windows);
}

export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (end > start) result.push({ start, end });
    if (a[i]!.end < b[j]!.end) i += 1;
    else j += 1;
  }
  return result;
}

export function suggestSlots(range: Interval, busy: readonly Interval[], timeZone: string, input: Pick<SuggestTimeArgs, "durationMinutes" | "preferences">): Interval[] {
  const minimum = (input.durationMinutes ?? DEFAULT_DURATION_MINUTES) * MINUTE;
  const count = Math.min(input.preferences?.pageSize ?? DEFAULT_SLOT_COUNT, MAX_SLOT_COUNT);
  return intersect(freeIntervals(range, busy), allowedWindows(range, timeZone, input.preferences))
    .filter((slot) => slot.end - slot.start >= minimum)
    .slice(0, count);
}

export function freeBusyRequest(emails: readonly string[], range: Interval, timeZone: string): GoogleRequest {
  return {
    method: "POST",
    readOnly: true,
    host: CALENDAR_HOST,
    path: `${CALENDAR_BASE}/freeBusy`,
    body: {
      timeMin: new Date(range.start).toISOString(),
      timeMax: new Date(range.end).toISOString(),
      timeZone,
      items: emails.map((id) => ({ id })),
    },
  };
}

interface FreeBusyAnswer {
  calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string }> }>;
}

function unavailable(emails: readonly string[]): GoogleToolError {
  return new GoogleToolError("permission_denied", `Google could not share availability for: ${emails.join(", ")}. Remove them or ask them to share their calendar.`);
}

export function busyFromFreeBusy(answer: FreeBusyAnswer, emails: readonly string[]): Interval[] {
  const calendars = new Map(Object.entries(answer.calendars ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const missing = emails.filter((email) => {
    const entry = calendars.get(email.toLowerCase());
    return !entry || (entry.errors?.length ?? 0) > 0;
  });
  if (missing.length) throw unavailable(missing);
  return emails.flatMap((email) => (calendars.get(email.toLowerCase())!.busy ?? []).map((item) => readableBusy({
    start: Date.parse(item.start ?? ""),
    end: Date.parse(item.end ?? ""),
  })));
}

function readableBusy(item: Interval): Interval {
  if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) {
    throw new GoogleToolError("invalid_response", "Google returned a busy time that could not be read, so no free time is suggested.");
  }
  return item;
}

export function attendeeEventsRequest(email: string, range: Interval, pageToken?: string): GoogleRequest {
  return {
    method: "GET",
    host: CALENDAR_HOST,
    path: eventsPath(email),
    query: {
      timeMin: new Date(range.start).toISOString(),
      timeMax: new Date(range.end).toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken,
      fields: "timeZone,nextPageToken,items(status,transparency,start,end,attendees(self,responseStatus))",
    },
  };
}

function boundary(value: RestEvent["start"], timeZone: string): number {
  if (value?.dateTime) return Date.parse(value.dateTime);
  if (value?.date) {
    try {
      return instantOf(parseTimeInput(value.date), value.timeZone ?? timeZone);
    } catch {
      return Number.NaN;
    }
  }
  return Number.NaN;
}

export function busyFromEvents(events: readonly RestEvent[], calendarZone: string): Interval[] {
  return events
    .filter((event) => event.status !== "cancelled" && event.transparency !== "transparent")
    .filter((event) => !event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === "declined"))
    .map((event) => readableBusy({ start: boundary(event.start, calendarZone), end: boundary(event.end, calendarZone) }));
}

async function busyFromCalendars(emails: readonly string[], range: Interval, timeZone: string, http: GoogleHttp): Promise<Interval[]> {
  const busy: Interval[] = [];
  const missing: string[] = [];
  for (const email of emails) {
    let pageToken: string | undefined;
    let pages = 0;
    try {
      do {
        const list = await http.send<{ timeZone?: string; items?: RestEvent[]; nextPageToken?: string }>(attendeeEventsRequest(email, range, pageToken));
        busy.push(...busyFromEvents(list.items ?? [], list.timeZone ?? timeZone));
        pageToken = list.nextPageToken;
        pages += 1;
        if (pageToken && pages >= MAX_EVENT_PAGES) throw new GoogleToolError("invalid_argument", "Too many events in this range. Narrow the time range.");
      } while (pageToken);
    } catch (error) {
      if (error instanceof GoogleToolError && (error.kind === "not_found" || error.kind === "permission_denied")) missing.push(email);
      else throw error;
    }
  }
  if (missing.length) throw unavailable(missing);
  return busy;
}

export function toTimeSlot(slot: Interval, timeZone: string) {
  const start = formatInZone(slot.start, timeZone);
  const end = formatInZone(slot.end, timeZone);
  return {
    startTime: start,
    endTime: end,
    durationMinutes: Math.floor((slot.end - slot.start) / MINUTE),
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
  };
}

export function suggestTimeResult(slots: readonly Interval[], timeZone: string): CallToolResult {
  return structuredResult({ timeSlots: slots.map((slot) => toTimeSlot(slot, timeZone)) });
}

const slotTime = {
  type: "object",
  properties: {
    dateTime: { type: "string", description: "RFC 3339 date-time with offset." },
    timeZone: { type: "string", description: "IANA time zone the date-time is shown in." },
  },
} as const;

export const suggestTime = defineTool({
  definition: {
    name: "suggest_time",
    title: "Suggest a meeting time",
    description: "Finds periods in a time range when all the given people are free, from their calendars' busy times. Each suggestion is a whole free period at least durationMinutes long, earliest first. Free periods are not split into meeting-length slots.",
    inputSchema: {
      type: "object",
      properties: {
        attendeeEmails: { type: "array", items: { type: "string" }, description: `Required. Email addresses of the people to find free time for, at most ${MAX_ATTENDEES}. Include the user's own address to count their calendar.` },
        startTime: { type: "string", description: `Required. Start of the search range (ISO 8601). ${TIME_RULES}` },
        endTime: { type: "string", description: `Required. End of the search range (ISO 8601), at most ${MAX_RANGE_DAYS} days after startTime. ${TIME_RULES}` },
        timeZone: timeZoneInput("for reading the times, for the daily hours in preferences, and for the times in the result."),
        durationMinutes: { type: "integer", description: `Optional. Shortest free period to return, in minutes. Default: ${DEFAULT_DURATION_MINUTES}.` },
        preferences: {
          type: "object",
          description: "Optional. Preferences for the suggestions.",
          properties: {
            startHour: { type: "string", description: "Optional. Earliest time of day, HH:mm (24-hour)." },
            endHour: { type: "string", description: "Optional. Latest time of day, HH:mm (24-hour); 24:00 means midnight. Must be later than startHour." },
            excludeWeekends: { type: "boolean", description: "Optional. Leave out Saturdays and Sundays." },
            pageSize: { type: "integer", description: `Optional. Most suggestions to return. Default: ${DEFAULT_SLOT_COUNT}, at most ${MAX_SLOT_COUNT}.` },
          },
        },
      },
      required: ["attendeeEmails", "startTime", "endTime"],
    },
    outputSchema: {
      type: "object",
      properties: {
        timeSlots: {
          type: "array",
          description: "Suggested free periods, earliest first.",
          items: {
            type: "object",
            properties: {
              startTime: { type: "string", description: "Deprecated: use start." },
              endTime: { type: "string", description: "Deprecated: use end." },
              durationMinutes: { type: "integer", description: "Deprecated. Length of the period in minutes." },
              start: slotTime,
              end: slotTime,
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: "Ask for fewer suggestions with a smaller preferences.pageSize.",
  async run(input, http) {
    assertTimeZone(input.timeZone);
    parseTimeInput(input.startTime, "startTime");
    parseTimeInput(input.endTime, "endTime");
    const timeZone = input.timeZone ?? await calendarTimeZone("primary", http);
    const range = suggestRange(input, timeZone);
    allowedWindows(range, timeZone, input.preferences);
    let busy: Interval[];
    try {
      busy = busyFromFreeBusy(await http.send<FreeBusyAnswer>(freeBusyRequest(input.attendeeEmails, range, timeZone)), input.attendeeEmails);
    } catch (error) {
      if (!(error instanceof GoogleWorkspaceAuthError && error.reason === "insufficient_scope")) throw error;
      busy = await busyFromCalendars(input.attendeeEmails, range, timeZone, http);
    }
    return suggestTimeResult(suggestSlots(range, busy, timeZone, input), timeZone);
  },
});
