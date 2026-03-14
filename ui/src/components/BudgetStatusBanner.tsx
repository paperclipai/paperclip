import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { formatCents } from "../lib/utils";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import type { Agent } from "@paperclipai/shared";

export type BudgetLevel = "ok" | "warning" | "exceeded";

function computeBudgetLevel(agent: Agent): {
  level: BudgetLevel;
  utilization: number | null;
} {
  if (agent.budgetMonthlyCents <= 0) return { level: "ok", utilization: null };
  const utilization = agent.spentMonthlyCents / agent.budgetMonthlyCents;
  if (utilization >= 1.0) return { level: "exceeded", utilization };
  if (utilization >= 0.8) return { level: "warning", utilization };
  return { level: "ok", utilization };
}

function hasBudgetOverride(agent: Agent): boolean {
  const metadata = agent.metadata as Record<string, unknown> | null;
  return metadata?.budgetOverride === true;
}

export function BudgetStatusBanner({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { level, utilization } = computeBudgetLevel(agent);

  const toggleOverride = useMutation({
    mutationFn: async () => {
      const currentMetadata = (agent.metadata as Record<string, unknown> | null) ?? {};
      const newOverride = !hasBudgetOverride(agent);
      return agentsApi.update(
        agent.id,
        { metadata: { ...currentMetadata, budgetOverride: newOverride } },
        companyId,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      }
    },
  });

  if (level === "ok") return null;

  const override = hasBudgetOverride(agent);
  const percent = utilization !== null ? Math.round(utilization * 100) : 0;

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 flex items-start gap-3",
        level === "exceeded"
          ? "border-red-500/40 bg-red-500/5 dark:bg-red-900/10"
          : "border-yellow-500/40 bg-yellow-500/5 dark:bg-yellow-900/10",
      )}
    >
      {level === "exceeded" ? (
        <ShieldAlert className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
      ) : (
        <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0 space-y-1">
        <p
          className={cn(
            "text-sm font-medium",
            level === "exceeded" ? "text-red-700 dark:text-red-400" : "text-yellow-700 dark:text-yellow-400",
          )}
        >
          {level === "exceeded" ? "Budget Exceeded" : "Budget Warning"}
        </p>
        <p className="text-xs text-muted-foreground">
          {percent}% of monthly budget used ({formatCents(agent.spentMonthlyCents)} / {formatCents(agent.budgetMonthlyCents)}).
          {level === "exceeded" && !override && " Agent runs are paused until the budget is increased or overridden."}
          {level === "exceeded" && override && " Budget override is active \u2014 agent will continue running."}
        </p>
        {/* Budget utilization bar */}
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mt-1">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              level === "exceeded" ? "bg-red-500" : "bg-yellow-500",
            )}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
      </div>
      {level === "exceeded" && (
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "shrink-0 text-xs",
            override
              ? "border-green-500/40 text-green-700 dark:text-green-400"
              : "border-red-500/40 text-red-700 dark:text-red-400",
          )}
          onClick={() => toggleOverride.mutate()}
          disabled={toggleOverride.isPending}
        >
          {override ? (
            <>
              <ShieldCheck className="h-3.5 w-3.5 mr-1" />
              Override Active
            </>
          ) : (
            "Override Budget"
          )}
        </Button>
      )}
    </div>
  );
}
