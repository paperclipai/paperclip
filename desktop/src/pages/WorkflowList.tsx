import { useNavigate } from "react-router";
import { Plus, GitBranch, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { workflowsApi, type Workflow } from "@/api/routines";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

export function WorkflowList() {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const { data: workflows = [], isLoading } = useQuery({
    queryKey: queryKeys.workflows.list(selectedCompanyId!),
    queryFn: () => workflowsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
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
      <div className="mb-4 flex justify-end">
        <button className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-medium" style={{ background: "var(--accent)", color: "var(--accent-fg)" }}>
          <Plus size={15} /> New Workflow
        </button>
      </div>

      {workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border py-16" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
          <GitBranch size={32} className="mb-3 opacity-30" style={{ color: "var(--fg-muted)" }} />
          <p className="text-[13px] font-medium" style={{ color: "var(--fg-secondary)" }}>No workflows yet</p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>Create a workflow to orchestrate multi-step agent pipelines.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {workflows.map((wf) => {
            let nodeCount = 0;
            try {
              const graph = JSON.parse(wf.graph || "{}");
              nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
            } catch { /* ignore */ }

            return (
              <div
                key={wf.id}
                onClick={() => navigate(`/workflows/${wf.id}/builder`)}
                className="flex cursor-pointer items-center gap-4 rounded-lg border px-5 py-4 transition-all"
                style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
                onMouseEnter={(e) => { (e.currentTarget).style.borderColor = "var(--accent)"; (e.currentTarget).style.boxShadow = "var(--shadow-1)"; }}
                onMouseLeave={(e) => { (e.currentTarget).style.borderColor = "var(--card-border)"; (e.currentTarget).style.boxShadow = "none"; }}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--accent-subtle)" }}>
                  <GitBranch size={16} style={{ color: "var(--accent)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{wf.name}</div>
                  <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
                    {nodeCount} nodes · {wf.updated_at ? new Date(wf.updated_at).toLocaleDateString() : "Draft"}
                  </div>
                </div>
                <span
                  className="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize"
                  style={{
                    background: wf.status === "active" ? "var(--success-subtle)" : "var(--bg-muted)",
                    color: wf.status === "active" ? "var(--success)" : "var(--fg-muted)",
                  }}
                >
                  {wf.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
