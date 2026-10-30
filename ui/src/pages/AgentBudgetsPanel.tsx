import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentDetail as AgentDetailRecord, BudgetOverview, BudgetPolicySummary } from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { BudgetIncidentCard } from "../components/BudgetIncidentCard";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";

type BudgetAgent = Pick<AgentDetailRecord, "id" | "name" | "status" | "pauseReason" | "budgetMonthlyCents" | "spentMonthlyCents">;

export function agentBudgetSummary(overview: BudgetOverview | undefined, agent: BudgetAgent, companyId: string): BudgetPolicySummary {
  const matched = overview?.policies.find((policy) => policy.scopeType === "agent" && policy.scopeId === agent.id);
  if (matched) return matched;
  const amount = agent.budgetMonthlyCents ?? 0;
  const observed = agent.spentMonthlyCents ?? 0;
  return {
    policyId: "",
    companyId,
    scopeType: "agent",
    scopeId: agent.id,
    scopeName: agent.name,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount,
    unpricedEventCount: 0,
    pendingRunCount: 0,
    unpricedUsagePolicy: "block",
    observedAmount: observed,
    remainingAmount: Math.max(0, amount - observed),
    utilizationPercent: amount > 0 ? Number(((observed / amount) * 100).toFixed(2)) : 0,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: true,
    isActive: amount > 0,
    status: amount > 0 && observed >= amount ? "hard_stop" : "ok",
    paused: agent.status === "paused",
    pauseReason: agent.pauseReason ?? null,
    windowStart: new Date(),
    windowEnd: new Date(),
  };
}

export function AgentBudgetsPanel({ agent, companyId }: { agent: BudgetAgent; companyId: string }) {
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
  const summary = agentBudgetSummary(overview.data, agent, companyId);
  const incidents = (overview.data?.activeIncidents ?? []).filter(
    (incident) => incident.scopeType === "agent" && incident.scopeId === agent.id,
  );
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  };
  const policy = useMutation({
    mutationFn: (changes: { amount?: number; reservationCents?: string; unpricedUsagePolicy?: "block" | "allow" }) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: "agent",
        scopeId: agent.id,
        metric: summary.metric,
        windowKind: summary.windowKind,
        ...changes,
      }),
    onSuccess: invalidate,
  });
  const incident = useMutation({
    mutationFn: (input: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) =>
      budgetsApi.resolveIncident(companyId, input.incidentId, input),
    onSuccess: invalidate,
  });

  if (overview.isLoading) return <PageSkeleton variant="costs" />;
  return (
    <div className="space-y-4">
      {overview.error && !overview.data ? (
        <p role="alert" className="text-sm text-destructive">Budget data could not be loaded. Showing the agent's saved monthly budget.</p>
      ) : null}
      {policy.error ? (
        <p role="alert" className="text-sm text-destructive">Could not update {agent.name}'s budget. Review the amount and try again.</p>
      ) : null}
      {incidents.map((entry) => (
        <BudgetIncidentCard
          key={entry.id}
          incident={entry}
          isMutating={incident.isPending}
          onKeepPaused={() => incident.mutate({ incidentId: entry.id, action: "keep_paused" })}
          onRaiseAndResume={(amount) => incident.mutate({ incidentId: entry.id, action: "raise_budget_and_resume", amount })}
        />
      ))}
      <BudgetPolicyCard
        summary={summary}
        isSaving={policy.isPending}
        onSave={(amount) => policy.mutate({ amount })}
        onReservationChange={(reservationCents) => policy.mutate({ reservationCents })}
        onUnpricedUsagePolicyChange={(unpricedUsagePolicy) => policy.mutate({ unpricedUsagePolicy })}
      />
    </div>
  );
}
