import type {
  AttemptRole,
  ExecutionProfile,
  IssueRouting,
  RouteDecision,
  RouteDecisionParticipant,
  RoutePoolClaim,
  RouteRule,
  RouteRuleDefaultsResult,
  CreateExecutionProfileInput,
  UpdateExecutionProfileInput,
  UpsertRouteRuleInput,
  RouteRuleDefaultsBindingsInput,
  TaskFactsInput,
  EscalateRouteInput,
  RescueRouteInput,
  OverrideRouteInput,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Dispatch and review-request answer HTTP 200 even when they refuse; the
 * refusal lives in the body. These unions mirror the server's DispatchResult /
 * ReviewRequestResult (server/src/services/routing/service.ts) so callers must
 * inspect the outcome instead of treating 200 as success.
 */
export type RouteDispatchResult =
  | { dispatched: true; decision: RouteDecision; claim: RoutePoolClaim; runId: string }
  | { dispatched: false; decision: RouteDecision; reason: "wake_rejected" };

export type RouteReviewRequestResult =
  | { state: "requested"; reviewIssueId: string; reviewer: RouteDecisionParticipant; created: boolean }
  | { state: "not-required"; decision: RouteDecision }
  | { state: "reviewer-unavailable"; decision: RouteDecision; blocked: boolean };

/**
 * Rescue records its escalation revision even when the follow-up dispatch is
 * refused; `dispatchError` carries that refusal (e.g. "attempt_active",
 * "pool_capacity_exhausted", "execution_profile_model_drift") and must be
 * shown next to the new revision, not treated as a failed call.
 */
export interface RouteRescueDispatchError {
  message: string;
  code?: string;
  [key: string]: unknown;
}

export interface RouteRescueResult {
  decision: RouteDecision;
  dispatch: RouteDispatchResult | null;
  dispatchError: RouteRescueDispatchError | null;
}

export const routingApi = {
  listProfiles: (companyId: string) =>
    api.get<ExecutionProfile[]>(`/companies/${companyId}/execution-profiles`),
  createProfile: (companyId: string, data: CreateExecutionProfileInput) =>
    api.post<ExecutionProfile>(`/companies/${companyId}/execution-profiles`, data),
  updateProfile: (profileId: string, data: UpdateExecutionProfileInput) =>
    api.patch<ExecutionProfile>(`/execution-profiles/${profileId}`, data),
  listRules: (companyId: string) =>
    api.get<RouteRule[]>(`/companies/${companyId}/route-rules`),
  upsertRule: (companyId: string, data: UpsertRouteRuleInput) =>
    api.put<RouteRule>(`/companies/${companyId}/route-rules`, data),
  applyDefaultRules: (companyId: string, bindings: RouteRuleDefaultsBindingsInput) =>
    api.post<RouteRuleDefaultsResult>(`/companies/${companyId}/route-rules/defaults`, bindings),
  getIssueRouting: (issueId: string) =>
    api.get<IssueRouting>(`/issues/${issueId}/routing`),
  routeIssue: (issueId: string, facts: TaskFactsInput) =>
    api.post<RouteDecision>(`/issues/${issueId}/routing/route`, { facts }),
  dispatch: (issueId: string) =>
    api.post<RouteDispatchResult>(`/issues/${issueId}/routing/dispatch`, {}),
  escalate: (issueId: string, data: EscalateRouteInput) =>
    api.post<RouteDecision>(`/issues/${issueId}/routing/escalate`, data),
  rescue: (issueId: string, data: RescueRouteInput) =>
    api.post<RouteRescueResult>(`/issues/${issueId}/routing/rescue`, data),
  override: (issueId: string, data: OverrideRouteInput) =>
    api.post<RouteDecision>(`/issues/${issueId}/routing/override`, data),
  requestReview: (issueId: string) =>
    api.post<RouteReviewRequestResult>(`/issues/${issueId}/routing/review-request`, {}),
  releaseClaim: (issueId: string, role: AttemptRole, reason: string) =>
    api.post<RoutePoolClaim>(`/issues/${issueId}/routing/release-claim`, { role, reason }),
};
