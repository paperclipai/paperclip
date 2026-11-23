import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { CALENDAR_BASE, CALENDAR_HOST } from "./event.js";
import { pageSizeInput, pageTokenInput } from "./schemas.js";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 250;

const args = z.object({
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().max(2048).optional(),
});
export type ListCalendarsArgs = z.infer<typeof args>;

interface RestCalendarListEntry { id?: string; summary?: string; summaryOverride?: string; description?: string; timeZone?: string }
export interface RestCalendarList { items?: RestCalendarListEntry[]; nextPageToken?: string }

export function listCalendarsRequest(input: ListCalendarsArgs): GoogleRequest {
  return {
    method: "GET",
    host: CALENDAR_HOST,
    path: `${CALENDAR_BASE}/users/me/calendarList`,
    query: { maxResults: Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE), pageToken: input.pageToken || undefined },
  };
}

export function listCalendarsResult(list: RestCalendarList): CallToolResult {
  return structuredResult(compact({
    calendars: (list.items ?? []).map((item) => compact({
      id: item.id ?? "",
      summary: item.summaryOverride ?? item.summary,
      description: item.description,
      timeZone: item.timeZone,
    })),
    nextPageToken: list.nextPageToken,
  }));
}

export function calendarProbeRequest(): GoogleRequest {
  return { ...listCalendarsRequest({ pageSize: 1 }), query: { maxResults: 1, fields: "items(id)" } };
}

export const listCalendars = defineTool({
  definition: {
    name: "list_calendars",
    title: "List calendars",
    description: "Lists the calendars the signed-in user owns or has subscribed to, as shown in Google Calendar's calendar list. Use it to turn a name such as \"my family calendar\" into a calendar ID. Other calendars shared with the user can still be read by their ID.",
    inputSchema: {
      type: "object",
      properties: { pageSize: pageSizeInput(DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE), pageToken: pageTokenInput },
    },
    outputSchema: {
      type: "object",
      properties: {
        calendars: {
          type: "array",
          description: "Calendars.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Calendar ID, an email address." },
              summary: { type: "string", description: "Title as the user sees it." },
              description: { type: "string", description: "Description." },
              timeZone: { type: "string", description: "IANA time zone." },
            },
          },
        },
        nextPageToken: { type: "string", description: "Token for the next page. Absent on the last page." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: "Ask for fewer calendars with a smaller pageSize.",
  async run(input, http) {
    return listCalendarsResult(await http.send<RestCalendarList>(listCalendarsRequest(input)));
  },
});
