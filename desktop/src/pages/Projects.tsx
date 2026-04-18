import { useState } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";

export function Projects() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const { data: projects = [], isLoading } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
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
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Projects</h1>
        <button
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          <Plus size={15} /> New Project
        </button>
      </div>

      <div className="grid gap-3">
        {projects.map((project) => {
          const leadAgent = project.lead_agent_id ? agentMap.get(project.lead_agent_id) : null;
          return (
            <div
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              className="cursor-pointer rounded-lg border px-5 py-4 transition-all hover:shadow-sm"
              style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--card-border)"; }}
            >
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 shrink-0 rounded-full" style={{ background: project.color || "var(--fg-muted)" }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{project.name}</div>
                  <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>{project.description}</div>
                </div>
                <div className="flex items-center gap-4 shrink-0 text-[12px]" style={{ color: "var(--fg-muted)" }}>
                  {leadAgent && (
                    <div className="flex items-center gap-1.5">
                      <div className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold" style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}>
                        {leadAgent.name[0]}
                      </div>
                      <span>{leadAgent.name}</span>
                    </div>
                  )}
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-medium capitalize" style={{ background: project.status === "active" ? "var(--success-subtle)" : "var(--bg-muted)", color: project.status === "active" ? "var(--success)" : "var(--fg-muted)" }}>
                    {project.status}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {projects.length === 0 && (
          <div className="py-16 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No projects yet.</div>
        )}
      </div>

      {selectedCompanyId && (
        <NewProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} companyId={selectedCompanyId} />
      )}
    </div>
  );
}
