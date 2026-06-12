import type { BudgetOverview, Issue } from "@paperclipai/shared";
import { api } from "./client";

// Mirrors server/src/services/plans.ts PlanTier + plan_details sidecar.
export interface PlanTier {
  id: string;
  kind: "phase" | "wave";
  name: string;
  requestedChildren: Record<string, unknown>[];
  childIssueIds: string[];
}

export type PlanState = "draft" | "activating" | "active" | "stopped" | "completed";

export interface PlanDetails {
  issueId: string;
  companyId: string;
  state: PlanState;
  tiers: PlanTier[];
  budgetCapCents: number | null;
  budgetCapTokens: number | null;
  gateProfile: "none" | "dev_team";
  activatedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetailResponse {
  issue: Issue;
  planDetails: PlanDetails;
  childStatuses: { id: string; status: string }[];
}

export interface CreatePlanInput {
  companyId: string;
  title: string;
  overview?: string | null;
  tiers?: PlanTier[];
  budgetCapCents?: number | null;
  budgetCapTokens?: number | null;
  gateProfile?: "none" | "dev_team";
  assigneeAgentId?: string | null;
}

export interface PlanStopResult {
  planDetails: PlanDetails;
  holdId: string | null;
  runsCancelled: number;
  wakeupsCancelled: number;
  statusesCancelled: number;
  message: string;
}

export interface ActivePlanMeter {
  planIssueId: string;
  title: string;
  budgetCapCents: number | null;
  budgetCapTokens: number | null;
  observedAmount: number | null;
  metric: string | null;
  utilizationPercent: number | null;
}

export type LiveMeterResponse = BudgetOverview & { activePlans: ActivePlanMeter[] };

export const plansApi = {
  create: (input: CreatePlanInput) =>
    api.post<{ issue: Issue; planDetails: PlanDetails }>(`/plans`, input),
  get: (issueId: string) => api.get<PlanDetailResponse>(`/plans/${issueId}`),
  updateTiers: (issueId: string, tiers: PlanTier[]) =>
    api.put<{ planDetails: PlanDetails }>(`/plans/${issueId}/tiers`, { tiers }),
  activate: (issueId: string) =>
    api.post<{ planDetails: PlanDetails; childIssueIds: string[] }>(
      `/plans/${issueId}/activate`,
      {},
    ),
  stop: (issueId: string, reason?: string) =>
    api.post<PlanStopResult>(`/plans/${issueId}/stop`, reason ? { reason } : {}),
  remove: (issueId: string) =>
    api.delete<{ deleted: true; deletedIssueIds: string[] }>(`/plans/${issueId}`),

  liveMeter: (companyId: string) =>
    api.get<LiveMeterResponse>(`/companies/${companyId}/budgets/live-meter`),
  engageKillSwitch: (companyId: string) =>
    api.post<{ stopped: true }>(`/companies/${companyId}/kill-switch`, {}),
  releaseKillSwitch: (companyId: string) =>
    api.post<{ released: true }>(`/companies/${companyId}/kill-switch/release`, {}),
  // Reason-aware re-activation; resolves manual/system/archived pauses. Budget
  // pauses return 409 (raise the budget cap to resume).
  reactivateCompany: (companyId: string) =>
    api.post<{ reactivated: true; alreadyActive?: boolean }>(`/companies/${companyId}/reactivate`, {}),
};
