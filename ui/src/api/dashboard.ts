import type { CeoControlRoomStatus, DashboardSummary, MicroRegistryExperiment, MicroRegistryOverview } from "@paperclipai/shared";
import type { MicroBoardReviewDecision } from "../lib/micro-registry";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  ceoControlRoom: (companyId: string) => api.get<CeoControlRoomStatus>(`/companies/${companyId}/ceo-control-room`),
  openOperationalIncident: (companyId: string, body: { routineTitle: string; routineId?: string | null; note?: string | null }) =>
    api.post<{ issue: { id: string; identifier?: string | null; title: string; status: string }; routine: { id: string; title: string; status: string } | null }>(
      `/companies/${companyId}/ceo-control-room/operational-loops/incident`,
      body,
    ),
  pauseOperationalRoutine: (companyId: string, routineId: string, body?: { note?: string | null }) =>
    api.post<{ routineId: string; title: string; status: "paused" }>(`/companies/${companyId}/ceo-control-room/routines/${routineId}/pause`, body ?? {}),
  microRegistry: (companyId: string) => api.get<MicroRegistryOverview>(`/companies/${companyId}/micro-registry`),
  recordMicroBoardReview: (
    companyId: string,
    experimentId: string,
    body: { decision: MicroBoardReviewDecision; note?: string | null },
  ) => api.patch<MicroRegistryExperiment>(`/companies/${companyId}/micro-registry/experiments/${experimentId}/board-review`, body),
};
