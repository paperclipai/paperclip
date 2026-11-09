import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import type { Agent, AgentLifecycleState } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { t, useTranslation } from "@/i18n";

function getPhases() {
  return {
    preparing: [t("agents.AgentLifecycleStatus.preparing"), t("agents.AgentLifecycleStatus.preparingHint")],
    verifying: [t("agents.AgentLifecycleStatus.verifying"), t("agents.AgentLifecycleStatus.verifyingHint")],
    pausing: [t("agents.AgentLifecycleStatus.pausing"), t("agents.AgentLifecycleStatus.pausingHint")],
    resuming: [t("agents.AgentLifecycleStatus.resuming"), t("agents.AgentLifecycleStatus.resumingHint")],
    terminating: [t("agents.AgentLifecycleStatus.terminating"), t("agents.AgentLifecycleStatus.terminatingHint")],
    cleaning_up: [t("agents.AgentLifecycleStatus.cleaningUp"), t("agents.AgentLifecycleStatus.cleaningUpHint")],
  } satisfies Partial<Record<AgentLifecycleState, [string, string]>>;
}

function getFailedPhases() {
  return {
    preparing: t("agents.AgentLifecycleStatus.failedPreparing"),
    verifying: t("agents.AgentLifecycleStatus.failedVerifying"),
    pausing: t("agents.AgentLifecycleStatus.failedPausing"),
    resuming: t("agents.AgentLifecycleStatus.failedResuming"),
    terminating: t("agents.AgentLifecycleStatus.failedTerminating"),
    cleaning_up: t("agents.AgentLifecycleStatus.failedCleaningUp"),
  };
}

function pendingPhase(state?: AgentLifecycleState) {
  const phases = getPhases();
  return state && state in phases ? phases[state as keyof typeof phases] : undefined;
}

export function agentLifecycleRefetchInterval(state?: AgentLifecycleState) {
  return pendingPhase(state) ? 2_000 : 30_000;
}

/** Poll lifecycle fields without refreshing the record used by editable forms. */
export function useAgentLifecycleStatus(agent?: Agent) {
  return useQuery({
    queryKey: [...queryKeys.agents.detail(agent?.id ?? ""), "lifecycle", agent?.companyId],
    queryFn: () => agentsApi.get(agent!.id, agent!.companyId),
    enabled: Boolean(agent),
    select: current => ({ status: current.status, pauseReason: current.pauseReason, pausedAt: current.pausedAt, lifecycleState: current.lifecycleState,
      lifecycleVersion: current.lifecycleVersion, lifecycleError: current.lifecycleError }),
    refetchInterval: query => agentLifecycleRefetchInterval(query.state.data?.lifecycleState ?? agent?.lifecycleState),
  });
}

export function AgentLifecycleStatus({ agent, onRetry, retryPending, refreshError = false }: {
  agent: Pick<Agent, "lifecycleState" | "lifecycleError">;
  onRetry: () => void;
  retryPending: boolean;
  refreshError?: boolean;
}) {
  const { t } = useTranslation();
  const failedPhases = getFailedPhases();
  const phase = pendingPhase(agent.lifecycleState);
  if (!phase && !refreshError) return null;
  return <div role="status" aria-live="polite" className="space-y-2 text-sm">
    {refreshError && <p className="text-destructive">{t("agents.AgentLifecycleStatus.refreshError")}</p>}
    {phase && <div className="flex flex-wrap items-center gap-2">
      <Badge variant={agent.lifecycleError ? "destructive" : "secondary"}>
        {!agent.lifecycleError && <Loader2 aria-hidden="true" className="mr-1 size-3 animate-spin motion-reduce:animate-none" />}
        {agent.lifecycleError ? failedPhases[agent.lifecycleState as keyof typeof failedPhases] : phase[0]}
      </Badge>
      {!agent.lifecycleError && <span className="text-muted-foreground">{phase[1]}</span>}
    </div>}
    {phase && agent.lifecycleError && <div className="flex flex-wrap items-center gap-2 text-destructive">
      <span>{agent.lifecycleError}</span>
      <Button variant="outline" size="sm" disabled={retryPending} onClick={onRetry}>
        {retryPending ? t("agents.AgentLifecycleStatus.retrying") : t("agents.AgentLifecycleStatus.retryNow")}
      </Button>
    </div>}
    {phase && agent.lifecycleError && <p className="text-muted-foreground">{agent.lifecycleState === "verifying"
      ? t("agents.AgentLifecycleStatus.verifyingRetryHint")
      : t("agents.AgentLifecycleStatus.defaultRetryHint")}</p>}
  </div>;
}
