import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import {
  assertTimeZone,
  CALENDAR_HOST,
  calendarId,
  calendarTimeZone,
  EVENT_TYPES,
  eventsPath,
  restEventType,
  timeZoneArg,
  toMcpEvent,
  type McpEventType,
  type RestEvent,
  type RestEventList,
} from "./event.js";
import { calendarIdInput, eventSchema, pageSizeInput, pageTokenInput, reminderSchema, TIME_RULES, timeZoneInput } from "./schemas.js";
import { addLocalDays, instantOf, parseTimeInput } from "./time.js";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 250;
export const MAX_SORTED_EVENTS = 2000;
const WEEK_MS = 7 * 86_400_000;
const ORDERS = ["default", "startTime", "startTimeDesc", "lastModified"] as const;
const DEFAULT_EVENT_TYPES: McpEventType[] = ["DEFAULT", "OUT_OF_OFFICE", "FOCUS_TIME", "FROM_GMAIL"];
const DESC_TOKEN_PREFIX = "desc.";

const args = z.object({
  eventTypeFilter: z.array(z.string().max(64)).max(10).optional(),
  eventType: z.array(z.enum(EVENT_TYPES)).max(10).optional(),
  calendarId: calendarId.optional(),
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().max(2048).optional(),
  startTime: z.string().max(64).optional(),
  endTime: z.string().max(64).optional(),
  timeZone: timeZoneArg.optional(),
  orderBy: z.enum(ORDERS).optional(),
  fullText: z.string().max(1024).optional(),
});
export type ListEventsArgs = z.infer<typeof args>;

export interface EventWindow { timeMin: number; timeMax: number }

export function needsCalendarTimeZone(input: Pick<ListEventsArgs, "startTime" | "endTime" | "timeZone">): boolean {
  if (input.timeZone) return false;
  return [input.startTime, input.endTime].some((value) => value !== undefined && parseTimeInput(value).offsetMinutes === null);
}

export function listEventsWindow(input: ListEventsArgs, timeZone: string | undefined, now: Date): EventWindow {
  const timeMin = input.startTime === undefined ? now.getTime() : instantOf(parseTimeInput(input.startTime, "startTime"), timeZone);
  let timeMax: number;
  if (input.endTime !== undefined) timeMax = instantOf(parseTimeInput(input.endTime, "endTime"), timeZone);
  else timeMax = timeZone ? addLocalDays(timeMin, 7, timeZone) : timeMin + WEEK_MS;
  if (timeMax <= timeMin) throw new GoogleToolError("invalid_argument", "endTime must be after startTime.");
  return { timeMin, timeMax };
}

const LEGACY_EVENT_TYPES: Record<string, McpEventType> = {
  default: "DEFAULT", outOfOffice: "OUT_OF_OFFICE", focusTime: "FOCUS_TIME", workingLocation: "WORKING_LOCATION", birthday: "BIRTHDAY", fromGmail: "FROM_GMAIL",
};

export function eventTypes(input: Pick<ListEventsArgs, "eventType" | "eventTypeFilter">): string[] {
  const legacy = (input.eventTypeFilter ?? []).map((value) => {
    if ((EVENT_TYPES as readonly string[]).includes(value)) return value as McpEventType;
    const mapped = LEGACY_EVENT_TYPES[value];
    if (!mapped) throw new GoogleToolError("invalid_argument", `eventTypeFilter has an unknown event type: ${JSON.stringify(value)}.`);
    return mapped;
  });
  const chosen = [...(input.eventType ?? []), ...legacy];
  return [...new Set((chosen.length ? chosen : DEFAULT_EVENT_TYPES).map(restEventType))];
}

export function listEventsRequest(
  input: ListEventsArgs,
  window: EventWindow,
  page: { pageToken?: string; pageSize?: number } = { pageToken: input.pageToken },
): GoogleRequest {
  const orderBy = input.orderBy === "startTime" || input.orderBy === "startTimeDesc" ? "startTime" : input.orderBy === "lastModified" ? "updated" : undefined;
  return {
    method: "GET",
    host: CALENDAR_HOST,
    path: eventsPath(input.calendarId),
    query: {
      timeMin: new Date(window.timeMin).toISOString(),
      timeMax: new Date(window.timeMax).toISOString(),
      singleEvents: true,
      orderBy,
      maxResults: page.pageSize ?? Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      pageToken: page.pageToken || undefined,
      q: input.fullText || undefined,
      timeZone: input.timeZone,
      eventTypes: eventTypes(input),
    },
  };
}

export function listEventsResult(list: RestEventList, events: RestEvent[], nextPageToken: string | undefined): CallToolResult {
  return structuredResult(compact({
    summary: list.summary,
    description: list.description,
    updated: list.updated,
    timeZone: list.timeZone,
    accessRole: list.accessRole,
    defaultReminders: list.defaultReminders?.length ? list.defaultReminders.map((item) => compact({ method: item.method, minutes: item.minutes })) : undefined,
    events: events.map(toMcpEvent),
    nextPageToken,
  }));
}

export function descPageToken(offset: number): string {
  return `${DESC_TOKEN_PREFIX}${offset}`;
}

export function descPageOffset(pageToken: string | undefined): number {
  if (!pageToken) return 0;
  const match = /^desc\.(\d{1,6})$/.exec(pageToken);
  if (!match) throw new GoogleToolError("invalid_argument", "pageToken does not belong to a startTimeDesc listing.");
  return Number(match[1]);
}

export function newestFirstPage(list: RestEventList, all: RestEvent[], input: ListEventsArgs): CallToolResult {
  const offset = descPageOffset(input.pageToken);
  const size = Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const sorted = [...all].reverse();
  const page = sorted.slice(offset, offset + size);
  return listEventsResult(list, page, offset + size < sorted.length ? descPageToken(offset + size) : undefined);
}

async function readAllForDescending(input: ListEventsArgs, window: EventWindow, http: GoogleHttp): Promise<{ list: RestEventList; events: RestEvent[] }> {
  const events: RestEvent[] = [];
  let first: RestEventList | undefined;
  let pageToken: string | undefined;
  do {
    const list = await http.send<RestEventList>(listEventsRequest(input, window, { pageToken, pageSize: MAX_PAGE_SIZE }));
    first ??= list;
    events.push(...(list.items ?? []));
    if (events.length > MAX_SORTED_EVENTS) {
      throw new GoogleToolError("invalid_argument", `More than ${MAX_SORTED_EVENTS} events match, too many to sort newest first. Narrow the time range or use orderBy startTime.`);
    }
    pageToken = list.nextPageToken;
  } while (pageToken);
  return { list: first ?? {}, events };
}

export const listEvents = defineTool({
  definition: {
    name: "list_events",
    description: "Lists events on one calendar that match all the given filters. Recurring events are returned as their individual occurrences. Set startTime or endTime only when the user asks about a specific time. For open-ended keyword or topic searches on the primary calendar, use search_events instead.",
    inputSchema: {
      type: "object",
      properties: {
        eventTypeFilter: { type: "array", items: { type: "string" }, description: "Deprecated: use eventType." },
        eventType: {
          type: "array",
          items: { type: "string", enum: [...EVENT_TYPES] },
          description: "Optional. Event types to return. Default: DEFAULT, OUT_OF_OFFICE, FOCUS_TIME and FROM_GMAIL.",
        },
        calendarId: calendarIdInput,
        pageSize: pageSizeInput(DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
        pageToken: pageTokenInput,
        startTime: { type: "string", description: `Optional. Start of the time range (ISO 8601), before endTime. Default: now. ${TIME_RULES}` },
        endTime: { type: "string", description: `Optional. End of the time range (ISO 8601), after startTime. Default: 7 days after startTime. ${TIME_RULES}` },
        timeZone: timeZoneInput("for reading times without an offset, and for the times in the result."),
        orderBy: {
          type: "string",
          enum: [...ORDERS],
          description: "Optional. default: unspecified but stable order. startTime: start time ascending. startTimeDesc: start time descending. lastModified: last change ascending.",
        },
        fullText: { type: "string", description: "Optional. Free-text, case-insensitive search over title, description, location and attendees. Every term must match." },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Calendar title." },
        description: { type: "string", description: "Calendar description." },
        updated: { type: "string", description: "Last change time of the calendar." },
        timeZone: { type: "string", description: "Calendar time zone." },
        accessRole: { type: "string", enum: ["none", "freeBusyReader", "reader", "writer", "owner"], description: "The user's access to the calendar." },
        defaultReminders: { type: "array", items: reminderSchema, description: "Default reminders on the calendar." },
        events: { type: "array", items: eventSchema, description: "Events." },
        nextPageToken: { type: "string", description: "Token for the next page. Absent on the last page." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    assertTimeZone(input.timeZone);
    const timeZone = input.timeZone ?? (needsCalendarTimeZone(input) ? await calendarTimeZone(input.calendarId, http) : undefined);
    const window = listEventsWindow(input, timeZone, new Date());
    if (input.orderBy === "startTimeDesc") {
      descPageOffset(input.pageToken);
      const { list, events } = await readAllForDescending(input, window, http);
      return newestFirstPage(list, events, input);
    }
    const list = await http.send<RestEventList>(listEventsRequest(input, window));
    return listEventsResult(list, list.items ?? [], list.nextPageToken);
  },
});
