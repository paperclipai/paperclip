import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defineTool, structuredResult } from "../tool.js";
import { calendarId, eventId, getEventRequest, toMcpEvent, type RestEvent } from "./event.js";
import { calendarIdInput, eventSchema } from "./schemas.js";

const args = z.object({ eventId, calendarId: calendarId.optional() });
export type GetEventArgs = z.infer<typeof args>;

export function getEventResult(event: RestEvent): CallToolResult {
  return structuredResult(toMcpEvent(event));
}

export const getEvent = defineTool({
  definition: {
    name: "get_event",
    description: "Gets one event from a calendar by event ID.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Required. Event ID, from list_events or search_events." },
        calendarId: calendarIdInput,
      },
      required: ["eventId"],
    },
    outputSchema: eventSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    return getEventResult(await http.send<RestEvent>(getEventRequest(input.calendarId, input.eventId)));
  },
});
