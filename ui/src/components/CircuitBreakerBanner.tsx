import { Zap, AlertOctagon } from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent } from "@paperclipai/shared";

interface CircuitBreakerInfo {
  pauseReason: string;
  pauseDetail?: string;
  pausedAt?: string;
}

function getCircuitBreakerInfo(agent: Agent): CircuitBreakerInfo | null {
  const metadata = agent.metadata as Record<string, unknown> | null;
  if (!metadata) return null;
  if (metadata.pauseReason !== "circuit_breaker") return null;
  return {
    pauseReason: metadata.pauseReason as string,
    pauseDetail: metadata.pauseDetail as string | undefined,
    pausedAt: metadata.pausedAt as string | undefined,
  };
}

export function CircuitBreakerBanner({ agent }: { agent: Agent }) {
  const info = getCircuitBreakerInfo(agent);

  if (!info || agent.status !== "paused") return null;

  return (
    <div className="rounded-lg border border-orange-500/40 bg-orange-500/5 dark:bg-orange-900/10 px-4 py-3 flex items-start gap-3">
      <AlertOctagon className="h-5 w-5 text-orange-500 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-sm font-medium text-orange-700 dark:text-orange-400">
          Circuit Breaker Tripped
        </p>
        <p className="text-xs text-muted-foreground">
          {info.pauseDetail ?? "Agent was auto-paused due to repeated failures or no-progress runs."}
        </p>
        <div className="flex items-center gap-3 mt-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Zap className="h-3 w-3" />
            <span>Resume the agent to reset the circuit breaker</span>
          </div>
          {info.pausedAt && (
            <span className="text-xs text-muted-foreground">
              Paused {new Date(info.pausedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
