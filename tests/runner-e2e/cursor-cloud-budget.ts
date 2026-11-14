import type { BudgetOverview, BudgetPolicySummary } from "../../packages/shared/src/types/budget.js";
import type { RunnerApi } from "./api.js";

const optIn = "PAPERCLIP_CURSOR_CLOUD_ALLOW_UNPRICED_QUALIFICATION";
const amount = 1_000;
type QualificationPolicy = Pick<BudgetPolicySummary, "companyId" | "scopeType" | "scopeId" | "metric" | "windowKind"
  | "amount" | "hardStopEnabled" | "isActive" | "unpricedUsagePolicy">;
export interface CursorCloudQualificationBudget {
  schema: "paperclip.e2e.cursor-cloud.qualification-budget.v1";
  unpricedUsageOptIn: true;
  policies: QualificationPolicy[];
}

export function assertCursorCloudQualificationBudgetOptIn(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment[optIn] !== "1") {
    throw new Error(`Cursor Cloud acceptance setup-blocked: explicitly approve unpriced qualification spend with ${optIn}=1. Provider cost remains unavailable.`);
  }
}

export async function configureCursorCloudQualificationBudget(input: {
  api: Pick<RunnerApi, "get" | "post">; companyId: string; agentId: string;
}): Promise<CursorCloudQualificationBudget> {
  assertCursorCloudQualificationBudgetOptIn();
  const { api, companyId, agentId } = input;
  const scopes = [{ scopeType: "company", scopeId: companyId }, { scopeType: "agent", scopeId: agentId }] as const;
  const companyPath = `/api/companies/${encodeURIComponent(companyId)}`;
  for (const scope of scopes) {
    await api.post(`${companyPath}/budgets/policies`, { ...scope, metric: "billed_cents", windowKind: "calendar_month_utc",
      amount, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  }
  const overview = await api.get<BudgetOverview>(`${companyPath}/budgets/overview`);
  if (!overview || overview.companyId !== companyId || !Array.isArray(overview.policies)) {
    throw new Error("Cursor Cloud acceptance budget policy readback did not match the owned fixture company.");
  }
  const policies = scopes.map(scope => {
    const matches = overview.policies.filter(policy => policy && policy.scopeType === scope.scopeType && policy.scopeId === scope.scopeId);
    const policy = matches[0];
    if (matches.length !== 1 || !policy || policy.companyId !== companyId || policy.metric !== "billed_cents"
      || policy.windowKind !== "calendar_month_utc" || policy.amount !== amount || policy.hardStopEnabled !== true
      || policy.isActive !== true || policy.unpricedUsagePolicy !== "allow") {
      throw new Error(`Cursor Cloud acceptance budget policy readback did not preserve the ${scope.scopeType} qualification limit.`);
    }
    return { companyId: policy.companyId, scopeType: policy.scopeType, scopeId: policy.scopeId, metric: policy.metric,
      windowKind: policy.windowKind, amount: policy.amount, hardStopEnabled: policy.hardStopEnabled,
      isActive: policy.isActive, unpricedUsagePolicy: policy.unpricedUsagePolicy };
  });
  return { schema: "paperclip.e2e.cursor-cloud.qualification-budget.v1", unpricedUsageOptIn: true, policies };
}
