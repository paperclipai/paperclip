import { ChartCard, IssueStatusChart, PriorityChart, RunActivityChart, SuccessRateChart } from "@/components/ActivityCharts";
import { useCompanyIssues, useDashboardSummary } from "./data";
import type { DashboardWidgetProps } from "./WidgetParts";

const SUBTITLE = "Last 14 days";

export function RunActivityWidget({ companyId }: DashboardWidgetProps) {
  const summary = useDashboardSummary(companyId);
  return (
    <ChartCard title="Run Activity" subtitle={SUBTITLE}>
      <RunActivityChart activity={summary.data?.runActivity} />
    </ChartCard>
  );
}

export function SuccessRateWidget({ companyId }: DashboardWidgetProps) {
  const summary = useDashboardSummary(companyId);
  return (
    <ChartCard title="Success Rate" subtitle={SUBTITLE}>
      <SuccessRateChart activity={summary.data?.runActivity} />
    </ChartCard>
  );
}

export function TasksByStatusWidget({ companyId }: DashboardWidgetProps) {
  const issues = useCompanyIssues(companyId);
  return (
    <ChartCard title="Tasks by Status" subtitle={SUBTITLE}>
      <IssueStatusChart issues={issues.data ?? []} />
    </ChartCard>
  );
}

export function TasksByPriorityWidget({ companyId }: DashboardWidgetProps) {
  const issues = useCompanyIssues(companyId);
  return (
    <ChartCard title="Tasks by Priority" subtitle={SUBTITLE}>
      <PriorityChart issues={issues.data ?? []} />
    </ChartCard>
  );
}
