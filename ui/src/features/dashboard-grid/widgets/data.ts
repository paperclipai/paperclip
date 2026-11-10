import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { activityApi } from "@/api/activity";
import { approvalsApi } from "@/api/approvals";
import { dashboardApi } from "@/api/dashboard";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

export const DASHBOARD_ACTIVITY_LIMIT = 10;

export function useDashboardSummary(companyId: string) {
  return useQuery({ queryKey: queryKeys.dashboard(companyId), queryFn: () => dashboardApi.summary(companyId) });
}

export function useCompanyAgents(companyId: string) {
  return useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
}

export function useCompanyIssues(companyId: string) {
  return useQuery({ queryKey: queryKeys.issues.list(companyId), queryFn: () => issuesApi.list(companyId) });
}

export function useRecentActivity(companyId: string) {
  return useQuery({
    queryKey: [...queryKeys.activity(companyId), { limit: DASHBOARD_ACTIVITY_LIMIT }] as const,
    queryFn: () => activityApi.list(companyId, { limit: DASHBOARD_ACTIVITY_LIMIT }),
  });
}

export function useCompanyLiveRuns(companyId: string) {
  return useQuery({ queryKey: queryKeys.liveRuns(companyId), queryFn: () => heartbeatsApi.liveRunsForCompany(companyId) });
}

export function usePendingApprovals(companyId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
    enabled,
  });
}
