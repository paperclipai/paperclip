import { Plus, Play, Clock, Pause, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { routinesApi, type Routine } from "@/api/routines";
import { agentsApi, type Agent } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

export function Routines() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data: routines = [], isLoading } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const triggerMutation = useMutation({
    mutationFn: (routineId: string) => routinesApi.trigger(selectedCompanyId!, routineId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--fg-muted)" }} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Routines</h1>
        <button
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          onClick={() => alert("New Routine dialog coming soon")}
        >
          <Plus size={15} /> New Routine
        </button>
      </div>

      {routines.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border py-16" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          <Clock size={32} className="mb-3 opacity-30" style={{ color: "var(--fg-muted)" }} />
          <p className="text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>No routines yet</p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>Create a routine to schedule recurring agent tasks.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              agent={agentMap.get(routine.assignee_agent_id ?? "")}
              onTrigger={() => triggerMutation.mutate(routine.id)}
              triggering={triggerMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoutineRow({ routine, agent, onTrigger, triggering }: { routine: Routine; agent?: Agent; onTrigger: () => void; triggering: boolean }) {
  const isPaused = routine.status === "paused";

  return (
    <div
      className="flex items-center gap-4 rounded-lg border px-5 py-4 transition-all cursor-pointer"
      style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
      onMouseEnter={(e) => { (e.currentTarget).style.borderColor = "var(--border)"; (e.currentTarget).style.boxShadow = "var(--shadow-1)"; }}
      onMouseLeave={(e) => { (e.currentTarget).style.borderColor = "var(--card-border)"; (e.currentTarget).style.boxShadow = "none"; }}
    >
      {/* Status icon */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md" style={{ background: isPaused ? "var(--warning-subtle)" : "var(--accent-subtle)" }}>
        {isPaused ? <Pause size={16} style={{ color: "var(--warning)" }} /> : <Clock size={16} style={{ color: "var(--accent)" }} />}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{routine.title}</div>
        <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--fg-muted)" }}>
          <span style={{ fontFamily: "var(--font-mono)" }}>{routine.concurrency_policy}</span>
          {agent && (
            <>
              <span>·</span>
              <span>{agent.name}</span>
            </>
          )}
        </div>
      </div>

      {/* Last triggered */}
      <div className="shrink-0 text-right">
        {routine.last_triggered_at && (
          <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
            Last: {new Date(routine.last_triggered_at).toLocaleString()}
          </div>
        )}
      </div>

      {/* Status badge */}
      <div
        className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize"
        style={{
          background: isPaused ? "var(--warning-subtle)" : "var(--success-subtle)",
          color: isPaused ? "var(--warning)" : "var(--success)",
        }}
      >
        {routine.status}
      </div>

      {/* Trigger button */}
      <button
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors"
        style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
        title="Trigger manually"
        disabled={triggering}
        onClick={(e) => { e.stopPropagation(); onTrigger(); }}
      >
        <Play size={14} />
      </button>
    </div>
  );
}
