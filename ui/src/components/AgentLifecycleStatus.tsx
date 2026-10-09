import type { Agent, AgentLifecycleState } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const phases = {
  preparing: ["Preparing agent", "Required resources are being prepared. Work stays queued."],
  verifying: ["Verifying agent", "The saved execution configuration is being checked. Work stays queued."],
  pausing: ["Pausing agent", "Waiting for execution and required resources to stop."],
  resuming: ["Resuming agent", "Required resources are being started. Work stays queued."],
  terminating: ["Terminating agent", "Stopping execution before resource cleanup."],
  cleaning_up: ["Cleaning up agent", "Required resources are being removed. Termination is not complete."],
} satisfies Partial<Record<AgentLifecycleState, [string, string]>>;

function pendingPhase(state?: AgentLifecycleState) {
  return state && state in phases ? phases[state as keyof typeof phases] : undefined;
}

export function agentLifecycleRefetchInterval(state?: AgentLifecycleState) {
  return pendingPhase(state) ? 2_000 : 30_000;
}

export function AgentLifecycleStatus({ agent, onRetry, retryPending }: {
  agent: Pick<Agent, "lifecycleState" | "lifecycleError">;
  onRetry: () => void;
  retryPending: boolean;
}) {
  const phase = pendingPhase(agent.lifecycleState);
  if (!phase) return null;
  return <div role="status" aria-live="polite" className="space-y-2 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={agent.lifecycleError ? "destructive" : "secondary"}>
        {!agent.lifecycleError && <Loader2 aria-hidden="true" className="mr-1 size-3 animate-spin motion-reduce:animate-none" />}
        {phase[0]}
      </Badge>
      <span className="text-muted-foreground">{phase[1]}</span>
    </div>
    {agent.lifecycleError && <div className="flex flex-wrap items-center gap-2 text-destructive">
      <span>{agent.lifecycleError}</span>
      <Button variant="outline" size="sm" disabled={retryPending} onClick={onRetry}>
        {retryPending ? "Retrying…" : "Retry"}
      </Button>
    </div>}
  </div>;
}
