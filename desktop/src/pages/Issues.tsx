import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus, Search, Play } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import type { IssueStatus, IssuePriority } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { tauriInvoke } from "@/api/tauri-client";
import { NewIssueDialog } from "@/components/issues/NewIssueDialog";

type FilterTab = "active" | "backlog" | "done";

const ACTIVE_STATUSES: IssueStatus[] = ["todo", "in_progress", "in_review", "blocked"];

const PRIORITY_COLORS: Record<IssuePriority, string> = {
  critical: "var(--destructive)",
  high: "var(--warning)",
  medium: "var(--accent)",
  low: "var(--fg-muted)",
  none: "var(--border)",
};

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  in_progress: { bg: "var(--accent-subtle)", fg: "var(--accent)", label: "In Progress" },
  todo: { bg: "var(--bg-muted)", fg: "var(--fg-secondary)", label: "Todo" },
  done: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Done" },
  in_review: { bg: "var(--warning-subtle)", fg: "var(--warning)", label: "In Review" },
  blocked: { bg: "var(--destructive-subtle)", fg: "var(--destructive)", label: "Blocked" },
  backlog: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Backlog" },
  cancelled: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Cancelled" },
};

export function Issues() {
  const [filter, setFilter] = useState<FilterTab>("active");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const { data: issues = [], isLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  if (isLoading) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  const filtered = issues.filter((issue) => {
    if (search && !issue.title.toLowerCase().includes(search.toLowerCase()) && !issue.identifier.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "active") return ACTIVE_STATUSES.includes(issue.status);
    if (filter === "backlog") return issue.status === "backlog";
    if (filter === "done") return issue.status === "done" || issue.status === "cancelled";
    return true;
  });

  const counts = {
    active: issues.filter((i) => ACTIVE_STATUSES.includes(i.status)).length,
    backlog: issues.filter((i) => i.status === "backlog").length,
    done: issues.filter((i) => i.status === "done" || i.status === "cancelled").length,
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Issues</h1>
        <div className="flex items-center gap-2">
          {(() => {
            const todoWithAssignees = issues.filter(i =>
              i.assignee_agent_id && (i.status === "todo" || i.status === "backlog")
            );
            if (todoWithAssignees.length === 0) return null;
            return (
              <button
                onClick={() => {
                  todoWithAssignees.forEach(issue => {
                    tauriInvoke("wake_agent", {
                      id: issue.assignee_agent_id,
                      source: "issue_list_bulk",
                      reason: `Work on ${issue.identifier}: ${issue.title}`,
                      payload: JSON.stringify({ issueId: issue.id }),
                    });
                  });
                }}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium"
                style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}
              >
                <Play size={14} /> Start All ({todoWithAssignees.length})
              </button>
            );
          })()}
          <button
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            <Plus size={15} /> New Issue
          </button>
        </div>
      </div>

      {/* Search */}
      <div
        className="mb-4 flex items-center gap-3 rounded-md border px-4 py-2 transition-colors focus-within:border-[var(--accent)]"
        style={{ background: "var(--input-bg)", borderColor: "var(--input-border)" }}
      >
        <Search size={16} style={{ color: "var(--fg-muted)" }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search issues..."
          className="flex-1 border-none bg-transparent text-[13px] outline-none"
          style={{ color: "var(--fg)", fontFamily: "var(--font-body)" }}
        />
      </div>

      {/* Filter tabs */}
      <div className="mb-6 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["active", "backlog", "done"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={cn("relative px-4 py-2 pb-3 text-[13px] capitalize")}
            style={{ color: filter === tab ? "var(--fg)" : "var(--fg-muted)", fontWeight: filter === tab ? 500 : 400, background: "none", border: "none", fontFamily: "var(--font-body)" }}
          >
            {tab} <span className="ml-1 text-[11px]" style={{ color: "var(--fg-muted)" }}>{counts[tab]}</span>
            {filter === tab && <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />}
          </button>
        ))}
      </div>

      {/* Issue rows */}
      <div>
        {filtered.map((issue) => (
          <div
            key={issue.id}
            onClick={() => navigate(`/issues/${issue.id}`)}
            className="flex cursor-pointer items-center gap-4 border-b px-4 py-3 transition-colors hover:bg-[var(--bg-subtle)]"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <div className="h-4 w-1 shrink-0 rounded" style={{ background: PRIORITY_COLORS[issue.priority] }} />
            <span className="w-16 shrink-0 text-xs" style={{ fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>
              {issue.identifier}
            </span>
            <span className="flex-1 truncate text-sm">{issue.title}</span>
            {STATUS_STYLES[issue.status] && (
              <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: STATUS_STYLES[issue.status].bg, color: STATUS_STYLES[issue.status].fg }}>
                {STATUS_STYLES[issue.status].label}
              </span>
            )}
            {issue.assignee_agent_id && !["done", "cancelled"].includes(issue.status) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  tauriInvoke("wake_agent", {
                    id: issue.assignee_agent_id,
                    source: "issue_list",
                    reason: `Work on ${issue.identifier}: ${issue.title}`,
                    payload: JSON.stringify({ issueId: issue.id }),
                  });
                }}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--accent-subtle)]"
                style={{ color: "var(--fg-muted)" }}
                title={`Start work: ${issue.title}`}
              >
                <Play size={12} />
              </button>
            )}
            {issue.assignee_agent_id && (
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}>
                {agentMap.get(issue.assignee_agent_id)?.name?.[0] ?? "?"}
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="py-16 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No issues match this filter.</div>
        )}
      </div>

      {selectedCompanyId && (
        <NewIssueDialog open={dialogOpen} onOpenChange={setDialogOpen} companyId={selectedCompanyId} />
      )}
    </div>
  );
}
