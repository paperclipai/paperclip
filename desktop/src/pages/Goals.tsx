import { useState } from "react";
import { ChevronRight, ChevronDown, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { goalsApi } from "@/api/goals";
import type { GoalNode } from "@/api/goals";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { NewGoalDialog } from "@/components/goals/NewGoalDialog";

const LEVEL_LABELS: Record<string, string> = { mission: "Mission", objective: "Objective", key_result: "Key Result", task: "Task" };
const STATUS_COLORS: Record<string, string> = { done: "var(--success)", in_progress: "var(--accent)", planned: "var(--fg-muted)" };

export function Goals() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { selectedCompanyId } = useCompany();

  const { data: goals = [], isLoading } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  if (isLoading) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Goals</h1>
        <button
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          <Plus size={15} /> New Goal
        </button>
      </div>

      <div className="rounded-lg border" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
        {goals.map((goal) => (
          <GoalRow key={goal.id} goal={goal} depth={0} agentMap={agentMap} />
        ))}
        {goals.length === 0 && (
          <div className="px-4 py-12 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No goals yet.</div>
        )}
      </div>

      {selectedCompanyId && (
        <NewGoalDialog open={dialogOpen} onOpenChange={setDialogOpen} companyId={selectedCompanyId} />
      )}
    </div>
  );
}

function GoalRow({ goal, depth, agentMap }: { goal: GoalNode; depth: number; agentMap: Map<string, { id: string; name: string }> }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = goal.children.length > 0;
  const ownerAgent = goal.owner_agent_id ? agentMap.get(goal.owner_agent_id) : null;

  return (
    <>
      <div
        className={cn("flex items-center gap-3 border-b px-4 py-3 transition-colors hover:bg-[var(--bg-subtle)]", depth === 0 && "font-medium")}
        style={{ borderColor: "var(--border-subtle)", paddingLeft: `${16 + depth * 24}px`, cursor: hasChildren ? "pointer" : "default" }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          expanded ? <ChevronDown size={14} style={{ color: "var(--fg-muted)" }} /> : <ChevronRight size={14} style={{ color: "var(--fg-muted)" }} />
        ) : (
          <span className="w-3.5" />
        )}

        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: STATUS_COLORS[goal.status] || "var(--border)" }} />

        <span className={cn("flex-1 text-sm", depth > 0 && "font-normal")}>{goal.title}</span>

        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}>
          {LEVEL_LABELS[goal.level] || goal.level}
        </span>

        {ownerAgent && (
          <div className="flex items-center gap-1.5 shrink-0 text-[12px]" style={{ color: "var(--fg-muted)" }}>
            <div className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold" style={{ background: "var(--bg-muted)" }}>
              {ownerAgent.name[0]}
            </div>
            {ownerAgent.name}
          </div>
        )}
      </div>

      {expanded && goal.children.map((child) => (
        <GoalRow key={child.id} goal={child} depth={depth + 1} agentMap={agentMap} />
      ))}
    </>
  );
}
