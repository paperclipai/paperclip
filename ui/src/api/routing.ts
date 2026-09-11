import type {
  AttemptRole,
  ExecutionProfile,
  IssueRouting,
  RouteDecision,
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
    api.post<unknown>(`/issues/${issueId}/routing/dispatch`, {}),
  escalate: (issueId: string, data: EscalateRouteInput) =>
    api.post<RouteDecision>(`/issues/${issueId}/routing/escalate`, data),
  rescue: (issueId: string, data: RescueRouteInput) =>
    api.post<{ decision: RouteDecision; dispatch: unknown }>(`/issues/${issueId}/routing/rescue`, data),
  override: (issueId: string, data: OverrideRouteInput) =>
    api.post<RouteDecision>(`/issues/${issueId}/routing/override`, data),
  requestReview: (issueId: string) =>
    api.post<unknown>(`/issues/${issueId}/routing/review-request`, {}),
  releaseClaim: (issueId: string, role: AttemptRole, reason: string) =>
    api.post<RoutePoolClaim>(`/issues/${issueId}/routing/release-claim`, { role, reason }),
};
