interface AgentInfo {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
}

interface ChatAgentStatusGridProps {
  agents: AgentInfo[];
  onNavigate: (path: string) => void;
}

const statusConfig: Record<string, { dot: string; label: string }> = {
  active: { dot: "bg-emerald-500", label: "active" },
  running: { dot: "bg-emerald-500", label: "running" },
  idle: { dot: "bg-gray-400", label: "idle" },
  paused: { dot: "bg-gray-400", label: "paused" },
  error: { dot: "bg-red-500", label: "error" },
  terminated: { dot: "bg-amber-500", label: "terminated" },
};

function getStatusConfig(status: string) {
  return statusConfig[status] ?? { dot: "bg-gray-400", label: status };
}

export function ChatAgentStatusGrid({ agents, onNavigate }: ChatAgentStatusGridProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm space-y-2">
      <p className="text-xs font-semibold">{agents.length} Agent{agents.length !== 1 ? "s" : ""}</p>

      <div className="grid grid-cols-2 gap-1.5">
        {agents.map((agent) => {
          const cfg = getStatusConfig(agent.status);
          return (
            <button
              key={agent.id}
              className="rounded-md border border-border/50 p-2 text-left hover:bg-accent/50 transition-colors"
              onClick={() => onNavigate(`agents/${agent.id}`)}
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full shrink-0 ${cfg.dot}`} />
                <span className="text-xs font-medium truncate">{agent.name}</span>
              </div>
              <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                {agent.title ?? agent.role}
              </p>
              <p className={`text-[10px] ${cfg.dot.replace("bg-", "text-").replace("-500", "-600").replace("-400", "-500")}`}>
                {cfg.label}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
