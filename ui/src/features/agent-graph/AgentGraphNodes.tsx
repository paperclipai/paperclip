import { memo, useEffect, useState } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { AGENT_ROLE_LABELS, AGENT_GRAPH_STICKY_TEXT_MAX, type AgentAppearance } from "@paperclipai/shared";
import { UserPlus, X } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentStatusCapsule } from "@/components/StatusBadge";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { cn, formatCents } from "@/lib/utils";
import { useAgentGraphActions } from "./AgentGraphActions";
import type { AgentFlowNode, DraftFlowNode, StickyFlowNode } from "./lib/graph-nodes";

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
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} aria-label={`Set who ${agent.name} reports to`} />
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
      <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} aria-label={`Add a report to ${agent.name}`} />
    </div>
  );
});

const STICKY_COLOR_CLASSES: Record<string, string> = {
  yellow: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/60 dark:text-amber-50",
  blue: "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-500/30 dark:bg-sky-950/60 dark:text-sky-50",
  green: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-950/60 dark:text-emerald-50",
  pink: "border-pink-300 bg-pink-50 text-pink-950 dark:border-pink-500/30 dark:bg-pink-950/60 dark:text-pink-50",
  gray: "border-border bg-muted text-foreground",
};

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<StickyFlowNode>) {
  const { sticky } = data;
  const actions = useAgentGraphActions();
  const [text, setText] = useState(sticky.text);
  useEffect(() => setText(sticky.text), [sticky.text]);
  return (
    <div
      data-testid="agent-graph-sticky"
      className={cn("h-full w-full rounded-md border p-2 shadow-sm", STICKY_COLOR_CLASSES[sticky.color], selected && "ring-1 ring-primary")}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        maxWidth={1_200}
        maxHeight={1_200}
        onResizeEnd={(_event, params) =>
          actions.updateSticky(sticky.id, { x: params.x, y: params.y, width: params.width, height: params.height })}
      />
      <textarea
        aria-label="Sticky note text"
        className="nodrag nowheel h-full w-full resize-none bg-transparent text-sm leading-5 outline-none placeholder:text-current placeholder:opacity-50"
        placeholder="Write a note…"
        maxLength={AGENT_GRAPH_STICKY_TEXT_MAX}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text !== sticky.text) actions.updateSticky(sticky.id, { text });
        }}
      />
    </div>
  );
});

export const DraftNode = memo(function DraftNode({ data, selected }: NodeProps<DraftFlowNode>) {
  const { draft, direction, managerName } = data;
  const actions = useAgentGraphActions();
  const horizontal = direction === "LR";
  return (
    <div
      data-testid="agent-graph-draft"
      aria-label={`Hire draft ${draft.name}. Not an agent yet.`}
      className={cn(
        "flex h-24 w-56 flex-col justify-between rounded-lg border border-dashed bg-card px-3 py-2 text-card-foreground",
        selected ? "border-primary ring-1 ring-primary" : "border-muted-foreground",
      )}
    >
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} isConnectable={false} />
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-5" title={draft.name}>{draft.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {draft.title ?? roleLabel(draft.role)}
            {managerName ? ` · reports to ${managerName}` : ""}
          </div>
        </div>
        <button
          type="button"
          className="nodrag rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Discard hire draft ${draft.name}`}
          onClick={() => actions.removeDraft(draft.id)}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className="shrink-0 whitespace-nowrap rounded-full border border-dashed border-muted-foreground px-2 py-0.5 text-xs text-muted-foreground"
          title="This draft is not an agent yet"
        >
          Draft
        </span>
        <button
          type="button"
          className="nodrag inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          onClick={() => actions.requestHire(draft.id)}
        >
          <UserPlus className="size-3.5" aria-hidden />
          Request hire
        </button>
      </div>
    </div>
  );
});

export const AGENT_GRAPH_NODE_TYPES = { agent: AgentNode, sticky: StickyNode, draft: DraftNode } as const;
