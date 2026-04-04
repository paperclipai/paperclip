import type {
  AutoLabelRule,
  AutoLabelRuleExecution,
  CreateAutoLabelRule,
  UpdateAutoLabelRule,
} from "@paperclipai/shared";
import { api } from "./client";

export interface DryRunResult {
  rule: { id: string; name: string; conditionExpression: string };
  issue: { id: string; identifier: string; title: string };
  conditionResult: boolean;
  wouldApplyAction: string | null;
  evaluationError: string | null;
}

export const autoLabelRulesApi = {
  list: (companyId: string) =>
    api.get<AutoLabelRule[]>(`/companies/${companyId}/auto-label-rules`),
  create: (companyId: string, data: CreateAutoLabelRule) =>
    api.post<AutoLabelRule>(`/companies/${companyId}/auto-label-rules`, data),
  update: (ruleId: string, data: UpdateAutoLabelRule) =>
    api.patch<AutoLabelRule>(`/auto-label-rules/${ruleId}`, data),
  remove: (ruleId: string) =>
    api.delete<AutoLabelRule>(`/auto-label-rules/${ruleId}`),
  dryRun: (ruleId: string, issueId: string) =>
    api.post<DryRunResult>(`/auto-label-rules/${ruleId}/dry-run`, { issueId }),
  listExecutions: (ruleId: string, limit = 50) =>
    api.get<AutoLabelRuleExecution[]>(
      `/auto-label-rules/${ruleId}/executions?limit=${limit}`,
    ),
};
