import { api } from "./client";

export interface CalendarEvent {
  id: string;
  kind: "routine" | "plugin_job";
  title: string;
  cronExpression: string;
  timezone: string | null;
  nextRunAt: string | null;
  status: string;
  assigneeAgentId?: string | null;
  routineId?: string | null;
  triggerId?: string | null;
  pluginJobId?: string | null;
}

export interface CalendarEventsResponse {
  events: CalendarEvent[];
}

export const calendarApi = {
  getEvents: (companyId: string, start: Date, end: Date) =>
    api.get<CalendarEventsResponse>(
      `/companies/${companyId}/calendar?start=${start.toISOString()}&end=${end.toISOString()}`,
    ),
};
