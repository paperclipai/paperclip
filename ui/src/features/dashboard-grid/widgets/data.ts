import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { activityApi } from "@/api/activity";
import { dashboardApi } from "@/api/dashboard";
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
