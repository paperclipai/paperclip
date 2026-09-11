import type { DashboardSummary } from "@paperclipai/shared";
import { Activity, AlertTriangle, ClipboardCheck, ReceiptText } from "lucide-react";
import { MetricCard } from "./MetricCard";
import { formatCents } from "../lib/utils";

interface DailyBriefWidgetProps {
  data: DashboardSummary;
  stalledCount?: number;
}

export function DailyBriefWidget({ data, stalledCount = 0 }: DailyBriefWidgetProps) {
  const decisions = data.pendingApprovals + data.budgets.pendingApprovals;
  const blockedAndStalled = data.tasks.blocked + stalledCount;

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Daily Brief
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          icon={ClipboardCheck}
          value={decisions}
          label="결정 필요"
          to="/approvals"
          description={
            decisions > 0 ? (
              <span className="text-amber-500 dark:text-amber-400">
                {decisions} item{decisions === 1 ? "" : "s"} awaiting decision
              </span>
            ) : (
              <span>No pending decisions</span>
            )
          }
        />
        <MetricCard
          icon={Activity}
          value={data.tasks.inProgress}
          label="실행 중"
          to="/issues"
          description={
            <span>
              {data.tasks.open} open · {data.tasks.done} done
            </span>
          }
        />
        <MetricCard
          icon={ReceiptText}
          value={formatCents(data.costs.monthSpendCents)}
          label="이번달 비용"
          to="/costs"
          description={
            data.costs.monthBudgetCents > 0 ? (
              <span>
                {data.costs.monthUtilizationPercent}% /{" "}
                {formatCents(data.costs.monthBudgetCents)} budget
              </span>
            ) : (
              <span>무제한 예산</span>
            )
          }
        />
        <MetricCard
          icon={AlertTriangle}
          value={blockedAndStalled}
          label="Blocked / Stalled"
          to="/issues"
          description={
            blockedAndStalled > 0 ? (
              <span className="text-amber-500 dark:text-amber-400">
                {data.tasks.blocked} blocked
                {stalledCount > 0 ? ` · ${stalledCount} stalled` : ""}
              </span>
            ) : (
              <span>No blockers</span>
            )
          }
        />
      </div>
    </div>
  );
}
