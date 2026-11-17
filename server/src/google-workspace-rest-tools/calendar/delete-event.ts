import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
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

export function isSeriesMaster(event: RestEvent): boolean {
  return Boolean(event.recurrence?.length) && !event.recurringEventId;
}

export function assertSingleEvent(event: RestEvent): void {
  if (isSeriesMaster(event)) {
    throw new GoogleToolError(
      "invalid_argument",
      "This ID is a whole recurring series. This tool deletes single events or single occurrences only. Pass one occurrence's ID (from list_events). Nothing was deleted.",
    );
  }
}

export function deleteEventResult(deleted: RestEvent): CallToolResult {
  return structuredResult(toMcpEvent({ ...deleted, status: "cancelled" }));
}

export const deleteEvent = defineTool({
  definition: {
    name: "delete_event",
    description: "Deletes one event, or one occurrence of a recurring event, and returns it as it was, with status cancelled. It never deletes a whole recurring series: a series ID is refused, so pass one occurrence's ID (from list_events). By default Google emails a cancellation to every attendee (notificationLevel ALL); pass notificationLevel NONE to delete it silently.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Required. ID of the event or occurrence to delete. A recurring series' ID is refused." },
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
    assertSingleEvent(current);
    await http.send(deleteEventRequest(input));
    return deleteEventResult(current);
  },
});
