import { useMemo } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { Agent } from "@paperclipai/shared";
import { AgentIcon } from "./AgentIconPicker";

interface OrgChartCardProps {
  agents: Agent[];
}

interface TreeNode {
  agent: Agent;
  children: TreeNode[];
}

const statusDot: Record<string, string> = {
  running: "bg-brand-accent",
  active: "bg-emerald-500",
  paused: "bg-amber-500",
  idle: "bg-amber-500",
  error: "bg-red-400",
  terminated: "bg-[#4A4A52]",
};

function buildForest(agents: Agent[]): TreeNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string | null, Agent[]>();
  for (const agent of agents) {
    const parentId = agent.reportsTo && byId.has(agent.reportsTo) ? agent.reportsTo : null;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(agent);
    childrenOf.set(parentId, siblings);
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name));
  }

  function build(agent: Agent): TreeNode {
    return {
      agent,
      children: (childrenOf.get(agent.id) ?? []).map(build),
    };
  }

  return (childrenOf.get(null) ?? []).map(build);
}

const MAX_VISIBLE_NODES = 7;

function MiniNode({ node, depth }: { node: TreeNode; depth: number }) {
  const dot = statusDot[node.agent.status] ?? "bg-neutral-400";
  return (
    <div className={cn("flex items-center gap-1.5 min-w-0", depth > 0 && "ml-4")}>
      <div className="relative shrink-0">
        <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center">
          <AgentIcon icon={node.agent.icon} className="h-3 w-3 text-foreground/60" />
        </div>
        <span className={cn("absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full border border-card", dot)} />
      </div>
      <span className="text-[11px] font-medium text-foreground/80 truncate leading-none">
        {node.agent.name}
      </span>
    </div>
  );
}

function flattenForDisplay(roots: TreeNode[], limit: number): { node: TreeNode; depth: number }[] {
  const result: { node: TreeNode; depth: number }[] = [];
  function walk(n: TreeNode, depth: number) {
    if (result.length >= limit) return;
    result.push({ node: n, depth });
    for (const child of n.children) walk(child, depth + 1);
  }
  for (const root of roots) walk(root, 0);
  return result;
}

export function OrgChartCard({ agents }: OrgChartCardProps) {
  const forest = useMemo(() => buildForest(agents), [agents]);
  const flatNodes = useMemo(() => flattenForDisplay(forest, MAX_VISIBLE_NODES), [forest]);
  const total = agents.length;
  const running = agents.filter((a) => a.status === "running").length;
  const paused = agents.filter((a) => a.status === "paused").length;
  const errors = agents.filter((a) => a.status === "error").length;
  const remaining = total - flatNodes.length;

  return (
    <Link to="/org-chart" className="no-underline text-inherit h-full">
      <div className="h-full rounded-xl border border-border bg-card px-4 py-4 sm:px-5 sm:py-5 shadow-sm transition-colors hover:bg-accent/50 cursor-pointer flex flex-col">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-3xl sm:text-4xl font-bold tracking-tight tabular-nums font-mono">{total}</p>
            <p className="text-[11px] sm:text-xs font-medium text-muted-foreground mt-1 uppercase tracking-wider">Agents</p>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground/50 tabular-nums mt-1">
            {running > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 bg-brand-accent" />
                {running}
              </span>
            )}
            {paused > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 bg-amber-500" />
                {paused}
              </span>
            )}
            {errors > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 bg-red-400" />
                {errors}
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col justify-center space-y-1.5">
          {flatNodes.map(({ node, depth }) => (
            <MiniNode key={node.agent.id} node={node} depth={depth} />
          ))}
          {remaining > 0 && (
            <span className="text-[10px] text-muted-foreground/50 ml-4">
              +{remaining} more
            </span>
          )}
          {total === 0 && (
            <span className="text-xs text-muted-foreground">No agents yet</span>
          )}
        </div>
      </div>
    </Link>
  );
}
