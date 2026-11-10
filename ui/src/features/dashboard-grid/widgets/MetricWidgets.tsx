import { Bot, CircleDot, DollarSign, ShieldCheck } from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
import { formatCents } from "@/lib/utils";
import { useDashboardSummary } from "./data";
import { WidgetQueryState, type DashboardWidgetProps } from "./WidgetParts";

type MetricKind = "agents" | "tasks" | "spend" | "approvals";

function MetricWidget({ companyId, kind }: { companyId: string; kind: MetricKind }) {
  const summary = useDashboardSummary(companyId);
  const data = summary.data;
  if (!data) return <WidgetQueryState query={summary} action="load this metric" />;
  if (kind === "agents") {
    return (
      <MetricCard
        icon={Bot}
        value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
        label="Agents Enabled"
        to="/agents"
        description={<span>{data.agents.running} running, {data.agents.paused} paused, {data.agents.error} errors</span>}
      />
    );
  }
  if (kind === "tasks") {
    return (
      <MetricCard
        icon={CircleDot}
        value={data.tasks.inProgress}
        label="Tasks In Progress"
        to="/issues"
        description={<span>{data.tasks.open} open, {data.tasks.blocked} blocked</span>}
      />
    );
  }
  if (kind === "spend") {
    return (
      <MetricCard
        icon={DollarSign}
        value={formatCents(data.costs.monthSpendCents)}
        label="Month Spend"
        to="/costs"
        description={
          <span>
            {data.costs.monthBudgetCents > 0
              ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
              : "Unlimited budget"}
          </span>
        }
      />
    );
  }
  return (
    <MetricCard
      icon={ShieldCheck}
      value={data.pendingApprovals + data.budgets.pendingApprovals}
      label="Pending Approvals"
      to="/approvals"
      description={
        <span>
          {data.budgets.pendingApprovals > 0
            ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
            : "Awaiting board review"}
        </span>
      }
    />
  );
}

export function AgentsMetricWidget({ companyId }: DashboardWidgetProps) {
  return <MetricWidget companyId={companyId} kind="agents" />;
}
export function TasksMetricWidget({ companyId }: DashboardWidgetProps) {
  return <MetricWidget companyId={companyId} kind="tasks" />;
}
export function SpendMetricWidget({ companyId }: DashboardWidgetProps) {
  return <MetricWidget companyId={companyId} kind="spend" />;
}
export function ApprovalsMetricWidget({ companyId }: DashboardWidgetProps) {
  return <MetricWidget companyId={companyId} kind="approvals" />;
}
