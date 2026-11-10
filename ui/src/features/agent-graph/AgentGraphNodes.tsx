import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AGENT_ROLE_LABELS, type AgentAppearance } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentStatusCapsule } from "@/components/StatusBadge";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { cn, formatCents } from "@/lib/utils";
import type { AgentFlowNode } from "./lib/graph-nodes";

const ROLE_LABELS = AGENT_ROLE_LABELS as Record<string, string>;

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function statusLabel(status: string): string {
  return (status === "active" ? "idle" : status).replace(/_/g, " ");
}

function BudgetMeter({ spent, budget }: { spent: number; budget: number }) {
  if (budget <= 0) {
    return <span className="font-mono text-xs text-muted-foreground">{formatCents(spent)} · no limit</span>;
  }
  const percent = Math.min(100, Math.round((spent / budget) * 100));
  return (
    <span className="flex items-center gap-2" title={`${formatCents(spent)} of ${formatCents(budget)} this month`}>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn("block h-full rounded-full", percent >= 90 ? "bg-destructive" : "bg-primary")}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="font-mono text-xs text-muted-foreground">{percent}%</span>
    </span>
  );
}

export const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { agent, live, direction } = data;
  const horizontal = direction === "LR";
  return (
    <div
      data-testid="agent-graph-node"
      data-status={agent.status}
      aria-label={`${agent.name}, ${agent.title ?? roleLabel(agent.role)}, ${statusLabel(agent.status)}`}
      className={cn(
        "flex h-24 w-56 flex-col justify-between rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-sm",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
        live && "agent-graph-node-live",
        agent.status === "error" && !selected && "border-destructive",
        (agent.status === "paused" || agent.status === "terminated") && "opacity-70",
      )}
    >
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} />
      <div className="flex min-w-0 items-center gap-2">
        <AgentAvatar agent={{ id: agent.id, name: agent.name, appearance: agent.appearance as AgentAppearance | null | undefined }} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-5" title={agent.name}>{agent.name}</div>
          <div className="truncate text-xs text-muted-foreground">{agent.title ?? roleLabel(agent.role)}</div>
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <AgentStatusCapsule status={agent.status} />
          <span className="sr-only">{statusLabel(agent.status)}</span>
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">{getAdapterLabel(agent.adapterType)}</span>
          <span className="shrink-0 capitalize">{statusLabel(agent.status)}</span>
        </div>
        <BudgetMeter spent={agent.spentMonthlyCents} budget={agent.budgetMonthlyCents} />
      </div>
      <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} />
    </div>
  );
});

export const AGENT_GRAPH_NODE_TYPES = { agent: AgentNode } as const;
