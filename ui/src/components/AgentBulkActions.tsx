import type { Agent } from "@paperclipai/shared";
import { Pause, Play, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentBulkActions } from "../hooks/useAgentBulkActions";

interface AgentBulkActionsProps {
  agents: Agent[];
  companyId: string;
}

export function AgentBulkActions({ agents, companyId }: AgentBulkActionsProps) {
  const { stoppableCount, startableCount, retryableCount, stopAll, startAll, retryFailed } =
    useAgentBulkActions(agents, companyId);

  const anyPending = stopAll.isPending || startAll.isPending || retryFailed.isPending;

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        disabled={stoppableCount === 0 || anyPending}
        onClick={() => {
          if (window.confirm(`Pause ${stoppableCount} active agent${stoppableCount !== 1 ? "s" : ""}?`)) {
            stopAll.mutate();
          }
        }}
      >
        {stopAll.isPending ? <Loader2 className="animate-spin" /> : <Pause />}
        <span className="hidden sm:inline">Stop All</span>
      </Button>
      <Button
        variant="ghost"
        size="xs"
        disabled={startableCount === 0 || anyPending}
        onClick={() => startAll.mutate()}
      >
        {startAll.isPending ? <Loader2 className="animate-spin" /> : <Play />}
        <span className="hidden sm:inline">Start All</span>
      </Button>
      <Button
        variant="ghost"
        size="xs"
        disabled={retryableCount === 0 || anyPending}
        onClick={() => retryFailed.mutate()}
      >
        {retryFailed.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        <span className="hidden sm:inline">Retry Failed</span>
      </Button>
    </>
  );
}
