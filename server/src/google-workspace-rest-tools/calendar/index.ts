import { createGoogleHttp, type GoogleFetch } from "../google-http.js";
import type { RestTool } from "../tool.js";
import { createEvent } from "./create-event.js";
import { deleteEvent } from "./delete-event.js";
import { getEvent } from "./get-event.js";
import { calendarProbeRequest, listCalendars } from "./list-calendars.js";
import { listEvents } from "./list-events.js";
import { respondToEvent } from "./respond-to-event.js";
import { searchEvents } from "./search-events.js";
import { suggestTime } from "./suggest-time.js";
import { updateEvent } from "./update-event.js";

export const CALENDAR_TOOLS: readonly RestTool[] = [
  listCalendars, getEvent, listEvents, searchEvents, suggestTime, createEvent, updateEvent, deleteEvent, respondToEvent,
];

export interface CalendarProbeInput { accessToken: string; fetch?: GoogleFetch; signal?: AbortSignal; timeoutMs?: number }

export async function probeCalendar(input: CalendarProbeInput): Promise<void> {
  await createGoogleHttp(input).send(calendarProbeRequest());
}
