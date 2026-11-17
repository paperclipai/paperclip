import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { CALENDAR_HOST, eventsPath, toMcpEvent, type RestEventList } from "./event.js";
import { eventTypes } from "./list-events.js";
import { eventSchema, pageSizeInput, pageTokenInput } from "./schemas.js";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 250;

const args = z.object({
  query: z.string().trim().min(1).max(1024),
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().max(2048).optional(),
});
export type SearchEventsArgs = z.infer<typeof args>;

export function searchEventsRequest(input: SearchEventsArgs): GoogleRequest {
  return {
    method: "GET",
    host: CALENDAR_HOST,
    path: eventsPath("primary"),
    query: {
      q: input.query,
      singleEvents: false,
      maxResults: Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      pageToken: input.pageToken || undefined,
      eventTypes: eventTypes({}),
    },
  };
}

export function searchEventsResult(list: RestEventList): CallToolResult {
  return structuredResult(compact({ events: (list.items ?? []).map(toMcpEvent), nextPageToken: list.nextPageToken }));
}

export const searchEvents = defineTool({
  definition: {
    name: "search_events",
    description: "Searches events on the signed-in user's primary calendar by keywords, across all dates. Matches title, description, location, attendees and organizer; every term must match. A recurring series is returned once, as the series, not as each occurrence; use list_events to see occurrences in a time range.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Required. Words to search for (case-insensitive)." },
        pageSize: pageSizeInput(DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
        pageToken: pageTokenInput,
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        events: { type: "array", items: eventSchema, description: "Matching events." },
        nextPageToken: { type: "string", description: "Token for the next page. Absent on the last page." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    return searchEventsResult(await http.send<RestEventList>(searchEventsRequest(input)));
  },
});
