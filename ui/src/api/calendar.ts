import type { CalendarEventKind, CalendarResult } from "@paperclipai/shared";
import { api } from "./client";

export interface CalendarQueryFilters {
  /** ISO timestamp of the window start. */
  from: string;
  /** ISO timestamp of the window end. */
  to: string;
  kinds?: CalendarEventKind[];
  agentId?: string;
  projectId?: string;
  routineId?: string;
}

export const calendarApi = {
  get: (companyId: string, filters: CalendarQueryFilters) => {
    const params = new URLSearchParams({ from: filters.from, to: filters.to });
    if (filters.kinds && filters.kinds.length > 0) params.set("kinds", filters.kinds.join(","));
    if (filters.agentId) params.set("agentId", filters.agentId);
    if (filters.projectId) params.set("projectId", filters.projectId);
    if (filters.routineId) params.set("routineId", filters.routineId);
    return api.get<CalendarResult>(`/companies/${companyId}/calendar?${params.toString()}`);
  },
};
