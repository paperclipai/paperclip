import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import {
  CALENDAR_HOST,
  calendarId,
  eventId,
  eventPath,
  getEventRequest,
  NOTIFICATION_LEVELS,
  sendUpdates,
  toMcpEvent,
  type RestEvent,
} from "./event.js";
import { calendarIdInput, eventSchema, notificationLevelInput } from "./schemas.js";

const args = z.object({
  eventId,
  calendarId: calendarId.optional(),
  notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
});
export type DeleteEventArgs = z.infer<typeof args>;

export function deleteEventRequest(input: DeleteEventArgs): GoogleRequest {
  return {
    method: "DELETE",
    host: CALENDAR_HOST,
    path: eventPath(input.calendarId, input.eventId),
    query: { sendUpdates: sendUpdates(input.notificationLevel, "ALL") },
  };
}

export function deleteEventResult(deleted: RestEvent): CallToolResult {
  return structuredResult(toMcpEvent({ ...deleted, status: "cancelled" }));
}

export const deleteEvent = defineTool({
  definition: {
    name: "delete_event",
    description: "Deletes one event from a calendar and returns the event as it was, with status cancelled. By default Google emails a cancellation to every attendee (notificationLevel ALL); pass notificationLevel NONE to delete it silently. Passing a recurring series' ID deletes the whole series; pass one occurrence's ID (from list_events) to delete only that occurrence.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Required. ID of the event to delete." },
        calendarId: calendarIdInput,
        notificationLevel: notificationLevelInput("ALL"),
      },
      required: ["eventId"],
    },
    outputSchema: eventSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    const current = await http.send<RestEvent>(getEventRequest(input.calendarId, input.eventId));
    await http.send(deleteEventRequest(input));
    return deleteEventResult(current);
  },
});
