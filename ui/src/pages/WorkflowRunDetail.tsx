import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@/lib/router";
import { ArrowLeft, Clock, Play, AlertTriangle } from "lucide-react";
import { workflowsApi } from "../api/workflows";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { WorkflowStepTimeline } from "../components/workflow/WorkflowStepTimeline";
import { WorkflowDiagram } from "../components/workflow/WorkflowDiagram";
import { Button } from "@/components/ui/button";

function runStatusBadge(status: string) {
  const colors: Record<string, string> = {
    completed: "bg-green-500/10 text-green-600",
    running: "bg-blue-500/10 text-blue-600",
    pending: "bg-yellow-500/10 text-yellow-600",
    waiting_input: "bg-purple-500/10 text-purple-600",
    failed: "bg-red-500/10 text-red-600",
    cancelled: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${colors[status] ?? "bg-muted text-muted-foreground"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function formatDuration(start: Date | string | null, end: Date | string | null): string | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const diffSec = Math.round((e - s) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h ${remainMin}m`;
}

export function WorkflowRunDetail() {
  const { workflowId, runId } = useParams<{ workflowId: string; runId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();

  const { data: workflow } = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId!),
    queryFn: () => workflowsApi.get(workflowId!),
    enabled: !!workflowId,
  });

  const { data: run, isLoading: runLoading } = useQuery({
    queryKey: queryKeys.workflows.runDetail(runId!),
    queryFn: () => workflowsApi.getRun(runId!),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "pending" || status === "waiting_input" ? 5000 : false;
    },
  });

  const { data: steps } = useQuery({
    queryKey: queryKeys.workflows.runSteps(runId!),
    queryFn: () => workflowsApi.getRunSteps(runId!),
    enabled: !!runId,
    refetchInterval: (query) => {
      return run?.status === "running" || run?.status === "pending" || run?.status === "waiting_input" ? 5000 : false;
    },
  });

  const { data: mermaidData } = useQuery({
    queryKey: queryKeys.workflows.runMermaid(runId!),
    queryFn: () => workflowsApi.getRunMermaid(runId!),
    enabled: !!runId && !!steps && steps.length > 0,
  });

  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: async () => {
      const res = await fetch(`/api/companies/${selectedCompanyId}/agents`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json() as Promise<Array<{ id: string; name: string }>>;
    },
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const agentName = run?.agentId
    ? agents.data?.find((a) => a.id === run.agentId)?.name ?? run.agentId.slice(0, 8)
    : null;

  useEffect(() => {
    if (!workflow) return;
    setBreadcrumbs([
      { label: "Workflows", href: "/workflows" },
      { label: workflow.name, href: `/workflows/${workflowId}` },
      { label: `Run ${runId?.slice(0, 8) ?? ""}` },
    ]);
  }, [workflow, workflowId, runId, setBreadcrumbs]);

  if (runLoading) return <PageSkeleton />;
  if (!run) return <div className="py-10 text-center text-sm text-muted-foreground">Run not found</div>;

  const completedSteps = steps?.filter((s) => s.status === "accepted" || s.status === "submitted").length ?? 0;
  const totalSteps = steps?.length ?? 0;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const duration = formatDuration(run.startedAt, run.completedAt);
  const isActive = run.status === "running" || run.status === "pending" || run.status === "waiting_input";

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate(`/workflows/${workflowId}`)}>
        <ArrowLeft className="mr-1.5 h-4 w-4" />
        Back to workflow
      </Button>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Run {run.id.slice(0, 8)}</h1>
          {runStatusBadge(run.status)}
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
          {run.triggerSource && (
            <div>
              <span className="text-muted-foreground">Trigger</span>
              <p className="font-medium">{run.triggerSource.replace(/_/g, " ")}</p>
            </div>
          )}
          {agentName && (
            <div>
              <span className="text-muted-foreground">Agent</span>
              <p className="font-medium">{agentName}</p>
            </div>
          )}
          {run.startedAt && (
            <div>
              <span className="text-muted-foreground">Started</span>
              <p className="font-medium" title={formatDateTime(run.startedAt)}>
                {relativeTime(run.startedAt)}
              </p>
            </div>
          )}
          {run.completedAt && (
            <div>
              <span className="text-muted-foreground">Completed</span>
              <p className="font-medium" title={formatDateTime(run.completedAt)}>
                {relativeTime(run.completedAt)}
              </p>
            </div>
          )}
          {duration && (
            <div>
              <span className="text-muted-foreground">Duration</span>
              <p className="font-medium flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {duration}{isActive && " (running)"}
              </p>
            </div>
          )}
          {run.workflowVersion != null && (
            <div>
              <span className="text-muted-foreground">Workflow version</span>
              <p className="font-medium">v{run.workflowVersion}</p>
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {totalSteps > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              <Play className="h-3.5 w-3.5" />
              Step progress
            </span>
            <span className="text-muted-foreground">
              {completedSteps} of {totalSteps} completed ({progressPct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                run.status === "failed" ? "bg-red-500" :
                run.status === "completed" ? "bg-green-500" :
                "bg-blue-500"
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Error display */}
      {run.error && (
        <div className="flex gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-500 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-red-600">Run error</p>
            <pre className="mt-1 whitespace-pre-wrap text-sm text-red-500/90">{run.error}</pre>
          </div>
        </div>
      )}

      {/* Run mermaid diagram */}
      {mermaidData?.mermaid && (
        <WorkflowDiagram source={mermaidData.mermaid} title="Execution Graph" />
      )}

      {/* Step timeline */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">Steps</h3>
        {!steps?.length ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No steps recorded</p>
        ) : (
          <div className="rounded-lg border p-4">
            <WorkflowStepTimeline steps={steps} currentStepKey={run.currentStepKey} showDetails />
          </div>
        )}
      </div>

      {/* Result data */}
      {run.resultJson && Object.keys(run.resultJson).length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Result</h3>
          <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs font-mono whitespace-pre-wrap">
            {JSON.stringify(run.resultJson, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
