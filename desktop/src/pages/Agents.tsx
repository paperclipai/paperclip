import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { agentsApi } from "@/api/agents";
import type { Agent, AgentStatus } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { NewAgentDialog } from "@/components/agents/NewAgentDialog";

type FilterTab = "all" | "active" | "paused" | "error";

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  running: { bg: "var(--accent-subtle)", fg: "var(--accent)", label: "Running" },
  active: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Active" },
  idle: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Idle" },
  paused: { bg: "var(--warning-subtle)", fg: "var(--warning)", label: "Paused" },
  error: { bg: "var(--destructive-subtle)", fg: "var(--destructive)", label: "Error" },
  terminated: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Terminated" },
};

const ADAPTER_LABELS: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  cursor_local: "Cursor",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  process: "Process",
  http: "HTTP",
};

const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO",
  manager: "Manager",
  general: "General",
  specialist: "Specialist",
  contractor: "Contractor",
};

export function Agents() {
  const [filter, setFilter] = useState<FilterTab>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const { data: agents = [], isLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  const filtered = agents.filter((a) => {
    if (filter === "all") return true;
    if (filter === "active") return a.status === "active" || a.status === "running" || a.status === "idle";
    return a.status === filter;
  });

  const counts = {
    all: agents.length,
    active: agents.filter((a) => ["active", "running", "idle"].includes(a.status)).length,
    paused: agents.filter((a) => a.status === "paused").length,
    error: agents.filter((a) => a.status === "error").length,
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>
          Agents
        </h1>
        <button
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium transition-colors"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          <Plus size={15} />
          New Agent
        </button>
      </div>

      {/* Filter tabs */}
      <div className="mb-6 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["all", "active", "paused", "error"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={cn(
              "relative px-4 py-2 pb-3 text-[13px] capitalize transition-colors",
              filter === tab ? "font-medium" : "",
            )}
            style={{
              color: filter === tab ? "var(--fg)" : "var(--fg-muted)",
              background: "none",
              border: "none",
              fontFamily: "var(--font-body)",
            }}
          >
            {tab}
            <span className="ml-1 text-[11px]" style={{ color: "var(--fg-muted)" }}>
              {counts[tab]}
            </span>
            {filter === tab && (
              <span
                className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t"
                style={{ background: "var(--accent)" }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Agent list */}
      <div className="flex flex-col gap-2">
        {filtered.map((agent) => (
          <AgentRow key={agent.id} agent={agent} onClick={() => navigate(`/agents/${agent.id}`)} />
        ))}
        {filtered.length === 0 && (
          <div className="py-16 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>
            No agents match this filter.
          </div>
        )}
      </div>

      {selectedCompanyId && (
        <NewAgentDialog open={dialogOpen} onOpenChange={setDialogOpen} companyId={selectedCompanyId} />
      )}
    </div>
  );
}

function AgentRow({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  const style = STATUS_STYLES[agent.status] || STATUS_STYLES.idle;
  const adapter = ADAPTER_LABELS[agent.adapter_type] || agent.adapter_type;
  const role = ROLE_LABELS[agent.role] || agent.role;

  return (
    <div
      onClick={onClick}
      className="flex cursor-pointer items-center gap-4 rounded-lg border px-5 py-4 transition-all"
      style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
        (e.currentTarget as HTMLElement).style.boxShadow = "var(--shadow-1)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "var(--card-border)";
        (e.currentTarget as HTMLElement).style.boxShadow = "none";
      }}
    >
      {/* Icon */}
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-lg"
        style={{ background: style.bg }}
      >
        {agent.icon || agent.name[0]}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{agent.name}</div>
        <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
          {role} · {adapter}
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-6 shrink-0">
        <div className="text-right">
          <div className="text-sm font-medium" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            ${(agent.spent_monthly_cents / 100).toFixed(2)}
          </div>
          <div className="text-[11px]" style={{ color: "var(--fg-muted)" }}>this month</div>
        </div>

        {/* Status badge */}
        <div
          className="flex items-center gap-2 rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ background: style.bg, color: style.fg }}
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full")}
            style={{
              background: style.fg,
              animation: agent.status === "running" ? "pulse-dot 2s ease-in-out infinite" : undefined,
            }}
          />
          {style.label}
        </div>
      </div>
    </div>
  );
}
