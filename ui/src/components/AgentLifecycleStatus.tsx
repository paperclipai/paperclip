import { t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import type { Agent, AgentLifecycleState } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const phases = () => ({
  preparing: [t("oct19Core.coverage004"), t("oct19Core.coverage005")],
  verifying: [t("oct19Core.coverage006"), t("oct19Core.coverage007")],
  pausing: [t("oct19Core.coverage008"), t("oct19Core.coverage009")],
  resuming: [t("oct19Core.coverage010"), t("oct19Core.coverage011")],
  terminating: [t("oct19Core.coverage012"), t("oct19Core.coverage013")],
  cleaning_up: [t("oct19Core.coverage014"), t("oct19Core.coverage015")],
} satisfies Partial<Record<AgentLifecycleState, [string, string]>>);

const failedPhases = () => ({
  preparing: t("oct19Core.coverage016"), verifying: t("oct19Core.coverage017"),
  pausing: t("oct19Core.coverage018"), resuming: t("oct19Core.coverage019"),
  terminating: t("oct19Core.coverage020"), cleaning_up: t("oct19Core.coverage021"),
});

function pendingPhase(state?: AgentLifecycleState) {
  const current = phases();
  return state && state in current ? current[state as keyof typeof current] : undefined;
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
    select: current => ({ status: current.status, lifecycleState: current.lifecycleState,
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
  useTranslation();
  const phase = pendingPhase(agent.lifecycleState);
  if (!phase && !refreshError) return null;
  return <div role="status" aria-live="polite" className="space-y-2 text-sm">
    {refreshError && <p className="text-destructive">{t("oct19Core.coverage022")}</p>}
    {phase && <div className="flex flex-wrap items-center gap-2">
      <Badge variant={agent.lifecycleError ? "destructive" : "secondary"}>
        {!agent.lifecycleError && <Loader2 aria-hidden="true" className="mr-1 size-3 animate-spin motion-reduce:animate-none" />}
        {agent.lifecycleError ? failedPhases()[agent.lifecycleState as keyof ReturnType<typeof failedPhases>] : phase[0]}
      </Badge>
      {!agent.lifecycleError && <span className="text-muted-foreground">{phase[1]}</span>}
    </div>}
    {phase && agent.lifecycleError && <div className="flex flex-wrap items-center gap-2 text-destructive">
      <span>{agent.lifecycleError}</span>
      <Button variant="outline" size="sm" disabled={retryPending} onClick={onRetry}>
        {retryPending ? t("oct19Core.coverage023") : t("oct19Core.coverage024")}
      </Button>
    </div>}
    {phase && agent.lifecycleError && <p className="text-muted-foreground">{t("oct19Core.coverage025")}</p>}
  </div>;
}
