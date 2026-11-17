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
const PAGE_TOKEN_PREFIX = "pc1.";

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
  page: { pageToken?: string; pageSize?: number } = {},
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

export interface PageState { timeMin: number; timeMax: number; googleToken?: string; offset?: number }

export function encodePageToken(state: PageState): string {
  return `${PAGE_TOKEN_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}

export function decodePageToken(pageToken: string | undefined, orderBy: ListEventsArgs["orderBy"]): PageState | undefined {
  if (!pageToken) return undefined;
  const invalid = () => new GoogleToolError("invalid_argument", "pageToken is not a nextPageToken from list_events with the same orderBy.");
  if (!pageToken.startsWith(PAGE_TOKEN_PREFIX)) throw invalid();
  let state: Partial<PageState>;
  try {
    state = JSON.parse(Buffer.from(pageToken.slice(PAGE_TOKEN_PREFIX.length), "base64url").toString("utf8")) as Partial<PageState>;
  } catch {
    throw invalid();
  }
  const { timeMin, timeMax, googleToken, offset } = state;
  if (!Number.isSafeInteger(timeMin) || !Number.isSafeInteger(timeMax) || timeMax! <= timeMin!) throw invalid();
  const descending = orderBy === "startTimeDesc";
  if (descending && !(Number.isSafeInteger(offset) && offset! >= 0)) throw invalid();
  if (!descending && (typeof googleToken !== "string" || googleToken.length === 0)) throw invalid();
  return descending ? { timeMin: timeMin!, timeMax: timeMax!, offset } : { timeMin: timeMin!, timeMax: timeMax!, googleToken };
}

export function newestFirstPage(list: RestEventList, all: RestEvent[], input: ListEventsArgs, window: EventWindow, offset: number): CallToolResult {
  const size = Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const sorted = [...all].reverse();
  const page = sorted.slice(offset, offset + size);
  const next = offset + size < sorted.length ? encodePageToken({ ...window, offset: offset + size }) : undefined;
  return listEventsResult(list, page, next);
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
    const page = decodePageToken(input.pageToken, input.orderBy);
    let window: EventWindow;
    if (page) window = { timeMin: page.timeMin, timeMax: page.timeMax };
    else {
      const timeZone = input.timeZone ?? (needsCalendarTimeZone(input) ? await calendarTimeZone(input.calendarId, http) : undefined);
      window = listEventsWindow(input, timeZone, new Date());
    }
    if (input.orderBy === "startTimeDesc") {
      const { list, events } = await readAllForDescending(input, window, http);
      return newestFirstPage(list, events, input, window, page?.offset ?? 0);
    }
    const list = await http.send<RestEventList>(listEventsRequest(input, window, { pageToken: page?.googleToken }));
    return listEventsResult(list, list.items ?? [], list.nextPageToken ? encodePageToken({ ...window, googleToken: list.nextPageToken }) : undefined);
  },
});
