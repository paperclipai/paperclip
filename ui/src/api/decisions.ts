import type { DecisionInput, DecisionOption } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Decisions v1 (PAP-14939 §4). Standalone decision objects proposed by agents
 * and resolved by the board. Open decisions surface in the attention feed as a
 * `decision` source; decided/expired history is fetched directly here. Response
 * DTOs mirror the P3 service (`server/src/services/decisions.ts`) and are kept
 * UI-local rather than in `@paperclipai/shared` on purpose — only the option /
 * input / effect specs are shared (they round-trip on create).
 */

export type DecisionStatus = "open" | "decided" | "expired" | "cancelled";
export type DecisionExecutionStatus = "running" | "succeeded" | "partial" | "failed";
export type DecisionEffectExecutionStatus = "claimed" | "executed" | "failed" | "skipped";

export interface DecisionTargetSnapshot {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: string;
  childCount: number;
}

export interface Decision {
  id: string;
  companyId: string;
  bundleId: string | null;
  originAgentId: string;
  originIssueId: string;
  originRunId: string;
  ruleKey: string | null;
  title: string;
  body: string;
  options: DecisionOption[];
  inputs: DecisionInput[] | null;
  status: DecisionStatus;
  executionStatus: DecisionExecutionStatus | null;
  chosenOptionId: string | null;
  inputValues: Record<string, string> | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  expiresAt: string;
  idempotencyKey: string | null;
  targetSnapshots: Record<string, DecisionTargetSnapshot>;
  continuationPolicy: "none" | "wake_origin_agent";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** `list()` annotates each open decision with which targets drifted since snapshot. */
export interface DecisionListItem extends Decision {
  targetChanged: Record<string, boolean>;
}

export interface DecisionEffectExecution {
  id: string;
  decisionId: string;
  effectIndex: number;
  effectType: string;
  targetIssueId: string;
  status: DecisionEffectExecutionStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  activityLogId: string | null;
  executedAt: string | null;
}

/** `get()` / `decide()` / `dismiss()` return the decision plus per-effect executions. */
export interface DecisionOutcome extends Decision {
  executions: DecisionEffectExecution[];
}

export interface DecisionListFilter {
  status?: DecisionStatus;
  bundleId?: string;
  targetIssueId?: string;
  originAgentId?: string;
  limit?: number;
}

export interface DecideInput {
  optionId: string;
  inputValues?: Record<string, string>;
  idempotencyKey?: string | null;
}

function listQuery(filter: DecisionListFilter): string {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.bundleId) params.set("bundleId", filter.bundleId);
  if (filter.targetIssueId) params.set("targetIssueId", filter.targetIssueId);
  if (filter.originAgentId) params.set("originAgentId", filter.originAgentId);
  if (filter.limit != null) params.set("limit", String(filter.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const decisionsApi = {
  list: (companyId: string, filter: DecisionListFilter = {}) =>
    api.get<DecisionListItem[]>(`/companies/${companyId}/decisions${listQuery(filter)}`),
  get: (id: string) => api.get<DecisionOutcome>(`/decisions/${id}`),
  decide: (id: string, input: DecideInput) =>
    api.post<DecisionOutcome>(`/decisions/${id}/decide`, input),
  dismiss: (id: string, reason?: string | null) =>
    api.post<DecisionOutcome>(`/decisions/${id}/dismiss`, reason ? { reason } : {}),
  cancel: (id: string) => api.post<Decision>(`/decisions/${id}/cancel`, {}),
};
