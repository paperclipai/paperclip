import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { projectsApi } from "@/api/projects";
import { issuesApi } from "@/api/issues";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  in_progress: { bg: "var(--accent-subtle)", fg: "var(--accent)", label: "In Progress" },
  todo: { bg: "var(--bg-muted)", fg: "var(--fg-secondary)", label: "Todo" },
  done: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Done" },
  in_review: { bg: "var(--warning-subtle)", fg: "var(--warning)", label: "In Review" },
  active: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Active" },
  backlog: { bg: "var(--bg-muted)", fg: "var(--fg-muted)", label: "Backlog" },
};

type Tab = "overview" | "issues" | "configuration";

export function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const { selectedCompanyId } = useCompany();

  const { data: project, isLoading } = useQuery({
    queryKey: queryKeys.projects.detail(projectId!),
    queryFn: () => projectsApi.get(projectId!),
    enabled: !!projectId,
  });

  const { data: issues = [] } = useQuery({
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
  const projectIssues = issues.filter((i) => i.project_id === projectId);

  if (isLoading || !project) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  const statusStyle = STATUS_STYLES[project.status];
  const leadAgent = project.lead_agent_id ? agentMap.get(project.lead_agent_id) : null;

  return (
    <div className="max-w-3xl">
      <button
        onClick={() => navigate("/projects")}
        className="mb-4 flex items-center gap-1.5 text-[13px]"
        style={{ color: "var(--fg-muted)" }}
      >
        <ArrowLeft size={14} /> Back to Projects
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-3">
          <div className="h-3 w-3 shrink-0 rounded-full" style={{ background: project.color || "var(--fg-muted)" }} />
          <h1 className="text-[20px] font-semibold" style={{ letterSpacing: "-0.01em" }}>{project.name}</h1>
          {statusStyle && (
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ background: statusStyle.bg, color: statusStyle.fg }}
            >
              {statusStyle.label}
            </span>
          )}
        </div>
        {project.description && (
          <p className="text-sm leading-relaxed" style={{ color: "var(--fg-secondary)" }}>{project.description}</p>
        )}
        {leadAgent && (
          <div className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: "var(--fg-muted)" }}>
            <span>Lead:</span>
            <div
              className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold"
              style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}
            >
              {leadAgent.name[0]}
            </div>
            <span>{leadAgent.name}</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["overview", "issues", "configuration"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn("relative px-4 py-2 pb-3 text-[13px] capitalize")}
            style={{
              color: activeTab === tab ? "var(--fg)" : "var(--fg-muted)",
              fontWeight: activeTab === tab ? 500 : 400,
              background: "none",
              border: "none",
              fontFamily: "var(--font-body)",
            }}
          >
            {tab}
            {activeTab === tab && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />
            )}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {activeTab === "overview" && (
        <div className="rounded-lg border p-5" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Description</div>
              <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--fg-secondary)" }}>{project.description || "\u2014"}</p>
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Created</div>
                <div className="mt-1 text-[13px]" style={{ color: "var(--fg-secondary)" }}>
                  {new Date(project.created_at).toLocaleDateString()}
                </div>
              </div>
              {project.target_date && (
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Target Date</div>
                  <div className="mt-1 text-[13px]" style={{ color: "var(--fg-secondary)" }}>
                    {new Date(project.target_date).toLocaleDateString()}
                  </div>
                </div>
              )}
              {leadAgent && (
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Lead Agent</div>
                  <div className="mt-1 flex items-center gap-2 text-[13px]">
                    <div
                      className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold"
                      style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}
                    >
                      {leadAgent.name[0]}
                    </div>
                    {leadAgent.name}
                  </div>
                </div>
              )}
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--fg-muted)" }}>Issues</div>
                <div className="mt-1 text-[13px]" style={{ color: "var(--fg-secondary)" }}>{projectIssues.length} total</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Issues tab */}
      {activeTab === "issues" && (
        <div>
          <div className="mb-3 text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>Issues in this project</div>
          <div>
            {projectIssues.map((issue) => {
              const issueStatus = STATUS_STYLES[issue.status];
              return (
                <div
                  key={issue.id}
                  onClick={() => navigate(`/issues/${issue.id}`)}
                  className="flex cursor-pointer items-center gap-3 border-b px-4 py-3 transition-colors hover:bg-[var(--bg-subtle)]"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <span className="w-16 shrink-0 text-xs" style={{ fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>
                    {issue.identifier}
                  </span>
                  <span className="flex-1 truncate text-sm">{issue.title}</span>
                  {issueStatus && (
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{ background: issueStatus.bg, color: issueStatus.fg }}
                    >
                      {issueStatus.label}
                    </span>
                  )}
                </div>
              );
            })}
            {projectIssues.length === 0 && (
              <div className="py-12 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No issues in this project.</div>
            )}
          </div>
        </div>
      )}

      {/* Configuration tab */}
      {activeTab === "configuration" && (
        <div className="py-12 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>
          Configuration options coming soon.
        </div>
      )}
    </div>
  );
}
