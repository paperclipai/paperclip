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
  gateEnforcement: "soft" | "strict";
  activatedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  estimatedCompletionAt: string | null;
  estimatorAgentId: string | null;
  etaOverrunNotifiedAt: string | null;
  lastMonitoredAt: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentHealth =
  | "working"
  | "stuck"
  | "stuck_critical"
  | "looping"
  | "needs_rewake"
  | "paused";

export interface AgentHealthEntry {
  agentId: string;
  agentName: string | null;
  issueId: string;
  health: AgentHealth;
  severity: "info" | "warning" | "critical";
  lastOutputAt: string | null;
  detail: string;
  runId?: string;
}

export interface PlanHealth {
  planIssueId: string;
  overdue: boolean;
  agents: AgentHealthEntry[];
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
  gateProfile?: "none" | "dev_team" | "light";
  gateEnforcement?: "soft" | "strict";
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

export interface SupervisionNote {
  id: string;
  companyId: string;
  planIssueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  kind: "observation" | "overrun" | "action";
  targetAgentId: string | null;
  targetIssueId: string | null;
  severity: "info" | "warning" | "critical";
  body: string;
  healthSnapshot: Record<string, unknown> | null;
  actionTaken: string | null;
  createdAt: string;
}

export interface AddSupervisionNoteInput {
  kind: "observation" | "overrun" | "action";
  severity?: "info" | "warning" | "critical";
  body: string;
  targetAgentId?: string | null;
  targetIssueId?: string | null;
  actionTaken?: string | null;
}

export type SupervisionAction =
  | { action: "rewake"; targetAgentId: string; body?: string }
  | { action: "cancel"; runId: string; targetAgentId?: string; reason?: string }
  | { action: "reassign"; targetIssueId: string; newAssigneeAgentId: string; body?: string }
  | { action: "stop_escalate"; reason?: string };

export const plansApi = {
  create: (input: CreatePlanInput) =>
    api.post<{ issue: Issue; planDetails: PlanDetails }>(`/plans`, input),
  get: (issueId: string) => api.get<PlanDetailResponse>(`/plans/${issueId}`),
  updateTiers: (issueId: string, tiers: PlanTier[]) =>
    api.put<{ planDetails: PlanDetails }>(`/plans/${issueId}/tiers`, { tiers }),
  setBudget: (issueId: string, caps: { budgetCapCents?: number | null; budgetCapTokens?: number | null }) =>
    api.patch<{ planDetails: PlanDetails }>(`/plans/${issueId}/budget`, caps),
  activate: (issueId: string) =>
    api.post<{ planDetails: PlanDetails; childIssueIds: string[] }>(
      `/plans/${issueId}/activate`,
      {},
    ),
  stop: (issueId: string, reason?: string) =>
    api.post<PlanStopResult>(`/plans/${issueId}/stop`, reason ? { reason } : {}),
  setEstimate: (
    issueId: string,
    body: { estimatedCompletionAt: string | null; estimatorAgentId?: string | null },
  ) => api.patch<{ planDetails: PlanDetails }>(`/plans/${issueId}/estimate`, body),
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

  supervisionHealth: (issueId: string) =>
    api.get<{ health: PlanHealth }>(`/plans/${issueId}/supervision/health`),
  supervisionNotes: (issueId: string) =>
    api.get<{ notes: SupervisionNote[] }>(`/plans/${issueId}/supervision-notes`),
  addSupervisionNote: (issueId: string, body: AddSupervisionNoteInput) =>
    api.post<{ note: SupervisionNote }>(`/plans/${issueId}/supervision-notes`, body),
  monitorNow: (issueId: string) =>
    api.post<{ woken: boolean }>(`/plans/${issueId}/supervision/monitor`, {}),
  takeAction: (issueId: string, action: SupervisionAction) =>
    api.post<{ note: SupervisionNote; actionTaken: string }>(`/plans/${issueId}/supervision/actions`, action),
};
