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
  type RestAttendee,
  type RestEvent,
} from "./event.js";
import { calendarIdInput, eventSchema, notificationLevelInput } from "./schemas.js";

const RESPONSES = ["declined", "tentative", "accepted"] as const;

const args = z.object({
  eventId,
  responseStatus: z.enum(RESPONSES),
  calendarId: calendarId.optional(),
  notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
  responseComment: z.string().max(8192).optional(),
});
export type RespondToEventArgs = z.infer<typeof args>;

export function respondedAttendees(input: RespondToEventArgs, current: RestEvent): RestAttendee[] {
  const attendees = current.attendees ?? [];
  if (!attendees.some((attendee) => attendee.self)) {
    throw new GoogleToolError("invalid_argument", "The user is not a guest of this event on this calendar, so there is no invitation to respond to.");
  }
  return attendees.map((attendee) => (attendee.self
    ? { ...attendee, responseStatus: input.responseStatus, ...(input.responseComment !== undefined ? { comment: input.responseComment } : {}) }
    : attendee));
}

export function respondToEventRequest(input: RespondToEventArgs, current: RestEvent): GoogleRequest {
  return {
    method: "PATCH",
    host: CALENDAR_HOST,
    path: eventPath(input.calendarId, input.eventId),
    query: { sendUpdates: sendUpdates(input.notificationLevel, "EXTERNAL_ONLY") },
    body: { attendees: respondedAttendees(input, current) },
    ifMatch: current.etag,
  };
}

export function respondToEventResult(event: RestEvent): CallToolResult {
  return structuredResult(toMcpEvent(event));
}

export const respondToEvent = defineTool({
  definition: {
    name: "respond_to_event",
    title: "Respond to an event",
    description: "Sets the signed-in user's response (accepted, tentative or declined) to an event they are invited to, with an optional comment, and returns the event. Passing a recurring series' ID responds for the whole series; passing one occurrence's ID (from list_events) responds for that occurrence only. The result shows which: a series has recurrence and no recurringEventId; one occurrence has recurringEventId. By default only attendees outside the organizer's domain are emailed (notificationLevel EXTERNAL_ONLY).",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Required. ID of the event to respond to." },
        responseStatus: { type: "string", enum: [...RESPONSES], description: "Required. The user's response: accepted, tentative or declined." },
        calendarId: calendarIdInput,
        notificationLevel: notificationLevelInput("EXTERNAL_ONLY"),
        responseComment: { type: "string", description: "Optional. Comment sent with the response." },
      },
      required: ["eventId", "responseStatus"],
    },
    outputSchema: eventSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    const current = await http.send<RestEvent>(getEventRequest(input.calendarId, input.eventId));
    return respondToEventResult(await http.send<RestEvent>(respondToEventRequest(input, current)));
  },
});
