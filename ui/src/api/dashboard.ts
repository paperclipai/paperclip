import type { CeoControlRoomStatus, DashboardSummary, MicroRegistryExperiment, MicroRegistryOverview } from "@paperclipai/shared";
import type { MicroBoardReviewDecision } from "../lib/micro-registry";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  ceoControlRoom: (companyId: string) => api.get<CeoControlRoomStatus>(`/companies/${companyId}/ceo-control-room`),
  microRegistry: (companyId: string) => api.get<MicroRegistryOverview>(`/companies/${companyId}/micro-registry`),
  recordMicroBoardReview: (
    companyId: string,
    experimentId: string,
    body: { decision: MicroBoardReviewDecision; note?: string | null },
  ) => api.patch<MicroRegistryExperiment>(`/companies/${companyId}/micro-registry/experiments/${experimentId}/board-review`, body),
};
