import { useTranslation, t } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import type { Agent, AgentLifecycleState } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const phases = {
  get preparing(): [string, string] { return [t("agent-config:preparingAgent_8829b03"), t("agent-config:requiredResourcesAreBeingPreparedWorkStaysQueued_2ab1e83")]; },
  get verifying(): [string, string] { return [t("agent-config:verifyingAgent_658ef25"), t("agent-config:theSavedExecutionConfigurationIsBeingCheckedWork_dd6af1d")]; },
  get pausing(): [string, string] { return [t("agent-config:pausingAgent_b8db8cf"), t("agent-config:waitingForExecutionAndRequiredResourcesToStop_efdcb87")]; },
  get resuming(): [string, string] { return [t("agent-config:resumingAgent_fcb5dae"), t("agent-config:requiredResourcesAreBeingStartedWorkStaysQueued_a469043")]; },
  get terminating(): [string, string] { return [t("agent-config:terminatingAgent_a07d51b"), t("agent-config:stoppingExecutionBeforeResourceCleanup_5ba362b")]; },
  get cleaning_up(): [string, string] { return [t("agent-config:cleaningUpAgent_5b939e4"), t("agent-config:requiredResourcesAreBeingRemovedTerminationIsNot_bb011e1")]; },
} satisfies Partial<Record<AgentLifecycleState, [string, string]>>;

const failedPhases = {
  get preparing() { return t("agent-config:agentPreparationFailed_bf9983d"); }, get verifying() { return t("agent-config:agentVerificationFailed_076d630"); },
  get pausing() { return t("agent-config:agentPauseFailed_9fd0ac3"); }, get resuming() { return t("agent-config:agentResumeFailed_b378cd0"); },
  get terminating() { return t("agent-config:agentTerminationFailed_c2eef9c"); }, get cleaning_up() { return t("agent-config:agentCleanupFailed_f527b22"); },
};

function pendingPhase(state?: AgentLifecycleState) {
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
  const { t } = useTranslation("agent-config");
  const phase = pendingPhase(agent.lifecycleState);
  if (!phase && !refreshError) return null;
  return <div role="status" aria-live="polite" className="space-y-2 text-sm">
    {refreshError && <p className="text-destructive">{t("agent-config:couldNotRefreshAgentLifecycleStatus_e0772ef")}</p>}
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
        {retryPending ? t("agent-config:retrying_2310131") : t("agent-config:retryNow_84ce86e")}
      </Button>
    </div>}
    {phase && agent.lifecycleError && <p className="text-muted-foreground">{agent.lifecycleState === "verifying"
      ? t("agent-config:retryNowChecksTheSavedConfigurationAgainImmediately_0205179")
      : t("agent-config:paperclipRetriesAutomaticallyRetryNowChecksAgainImmediately_32dc18b")}</p>}
  </div>;
}
