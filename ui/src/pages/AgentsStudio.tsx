import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Boxes,
  CalendarClock,
  ClipboardList,
  DollarSign,
  Factory,
  Play,
  Plus,
  Rocket,
  Server,
  ShoppingCart,
  Trash2,
  Users,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentWorkflow, AgentWorkflowRun, WorkflowConnector, WorkflowTemplate } from "@paperclipai/shared";
import { agentsStudioApi } from "../api/agentsStudio";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StudioBuilder } from "../components/StudioBuilder";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const CONNECTOR_ICONS: Record<WorkflowConnector, LucideIcon> = {
  core: Bot,
  it: Server,
  hr: Users,
  finance: DollarSign,
  procurement: ShoppingCart,
  sap: Boxes,
  workday: CalendarClock,
  jira: ClipboardList,
};

const CONNECTOR_ACCENT: Record<WorkflowConnector, string> = {
  core: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  it: "bg-blue-500/10 text-blue-600 dark:text-blue-300",
  hr: "bg-rose-500/10 text-rose-600 dark:text-rose-300",
  finance: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  procurement: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
  sap: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
  workday: "bg-orange-500/10 text-orange-600 dark:text-orange-300",
  jira: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
};

function ConnectorChip({ connector }: { connector: WorkflowConnector }) {
  const Icon = CONNECTOR_ICONS[connector] ?? Bot;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${CONNECTOR_ACCENT[connector] ?? CONNECTOR_ACCENT.core}`}
    >
      <Icon className="h-3 w-3" />
      {connector.toUpperCase()}
    </span>
  );
}

function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active" || status === "succeeded") return "default";
  if (status === "failed") return "destructive";
  if (status === "draft" || status === "paused") return "secondary";
  return "outline";
}

export function AgentsStudio() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [expandedRunsFor, setExpandedRunsFor] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents Studio" }]);
  }, [setBreadcrumbs]);

  const templatesQuery = useQuery({
    queryKey: queryKeys.agentsStudio.templates(),
    queryFn: () => agentsStudioApi.listTemplates().then((r) => r.templates),
  });

  const workflowsQuery = useQuery({
    queryKey: queryKeys.agentsStudio.list(selectedCompanyId!),
    queryFn: () => agentsStudioApi.list(selectedCompanyId!).then((r) => r.workflows),
    enabled: !!selectedCompanyId,
  });

  const invalidateWorkflows = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.agentsStudio.list(selectedCompanyId!) });

  const deployMutation = useMutation({
    mutationFn: (templateKey: string) => agentsStudioApi.deployTemplate(selectedCompanyId!, templateKey),
    onSuccess: (res) => {
      pushToast({ title: `Deployed “${res.workflow.name}”`, tone: "success" });
      invalidateWorkflows();
    },
    onError: (e: Error) => pushToast({ title: "Deploy failed", body: e.message, tone: "error" }),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => agentsStudioApi.run(selectedCompanyId!, id),
    onSuccess: (res) => {
      const ok = res.run.status === "succeeded";
      pushToast({
        title: `Run ${res.run.status} — ${res.run.stepResults.length} step(s)`,
        tone: ok ? "success" : "error",
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agentsStudio.runs(selectedCompanyId!, res.run.workflowId),
      });
      setExpandedRunsFor(res.run.workflowId);
    },
    onError: (e: Error) => pushToast({ title: "Run failed", body: e.message, tone: "error" }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => agentsStudioApi.remove(selectedCompanyId!, id),
    onSuccess: () => {
      pushToast({ title: "Workflow deleted", tone: "success" });
      invalidateWorkflows();
    },
    onError: (e: Error) => pushToast({ title: "Delete failed", body: e.message, tone: "error" }),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Factory} message="Select a company to open Agents Studio." />;
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Factory className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Agents Studio</h1>
          <Badge variant="outline" className="ml-1">
            AI Factory
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Create agents and stitch integrator actions into workflows across IT, HR, Finance, Procurement, SAP,
          Workday, and Jira — build your own or deploy a starter blueprint, then run it.
        </p>
      </header>

      <StudioBuilder companyId={selectedCompanyId} />

      {/* Template gallery */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Deploy a blueprint</h2>
        </div>
        {templatesQuery.isLoading ? (
          <PageSkeleton variant="list" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(templatesQuery.data ?? []).map((tpl: WorkflowTemplate) => (
              <div
                key={tpl.key}
                className="flex flex-col rounded-lg border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="mb-2 flex items-center gap-2">
                  <ConnectorChip connector={tpl.category} />
                  <span className="text-sm font-medium">{tpl.name}</span>
                </div>
                <p className="mb-3 flex-1 text-xs text-muted-foreground">{tpl.description}</p>
                <div className="mb-3 flex flex-wrap gap-1">
                  {tpl.steps.map((s) => (
                    <ConnectorChip key={s.id} connector={s.connector} />
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={deployMutation.isPending}
                  onClick={() => deployMutation.mutate(tpl.key)}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Deploy
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Deployed workflows */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Your workflows</h2>
        </div>
        {workflowsQuery.isLoading ? (
          <PageSkeleton variant="list" />
        ) : (workflowsQuery.data ?? []).length === 0 ? (
          <EmptyState icon={WorkflowIcon} message="No workflows yet. Deploy a blueprint above to get started." />
        ) : (
          <div className="space-y-2">
            {(workflowsQuery.data ?? []).map((wf) => (
              <WorkflowRow
                key={wf.id}
                companyId={selectedCompanyId}
                workflow={wf}
                expanded={expandedRunsFor === wf.id}
                onToggleRuns={() => setExpandedRunsFor((cur) => (cur === wf.id ? null : wf.id))}
                onRun={() => runMutation.mutate(wf.id)}
                onDelete={() => removeMutation.mutate(wf.id)}
                running={runMutation.isPending && runMutation.variables === wf.id}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function WorkflowRow({
  companyId,
  workflow,
  expanded,
  onToggleRuns,
  onRun,
  onDelete,
  running,
}: {
  companyId: string;
  workflow: AgentWorkflow;
  expanded: boolean;
  onToggleRuns: () => void;
  onRun: () => void;
  onDelete: () => void;
  running: boolean;
}) {
  const runsQuery = useQuery({
    queryKey: queryKeys.agentsStudio.runs(companyId, workflow.id),
    queryFn: () => agentsStudioApi.listRuns(companyId, workflow.id).then((r) => r.runs),
    enabled: expanded,
  });

  const [channel, setChannel] = useState<{ token: string; path: string } | null>(null);
  const deployMutation = useMutation({
    mutationFn: () => agentsStudioApi.deployChannel(companyId, workflow.id),
    onSuccess: (res) => setChannel({ token: res.token, path: res.path }),
  });
  const channelUrl = channel ? `${window.location.origin}${channel.path}` : "";

  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{workflow.name}</span>
            <Badge variant={statusVariant(workflow.status)}>{workflow.status}</Badge>
            {workflow.templateKey && (
              <Badge variant="outline" className="text-[10px]">
                blueprint
              </Badge>
            )}
          </div>
          {workflow.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{workflow.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {workflow.steps.map((step, i) => (
              <span key={step.id} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted-foreground/50">→</span>}
                <span title={step.name}>
                  <ConnectorChip connector={step.connector} />
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="default" onClick={onRun} disabled={running}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {running ? "Running…" : "Run"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => deployMutation.mutate()}
            disabled={deployMutation.isPending}
            title="Mint a channel URL + token so Slack/Teams/web can run this workflow"
          >
            <Rocket className="mr-1.5 h-3.5 w-3.5" />
            {deployMutation.isPending ? "Deploying…" : "Deploy"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onToggleRuns}>
            {expanded ? "Hide runs" : "Runs"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete workflow">
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {channel && (
        <div className="mt-3 rounded-md border border-dashed bg-muted/40 p-3">
          <p className="mb-1 text-xs font-medium">Channel deployed — point Slack / Teams / web at:</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
{`curl -X POST ${channelUrl} \\
  -H "Authorization: Bearer ${channel.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Onboard Jane Doe"}'`}
          </pre>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Save the token now — it isn’t shown again. Re-deploy to rotate it.
          </p>
        </div>
      )}

      {expanded && (
        <div className="mt-3 border-t pt-3">
          {runsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading runs…</p>
          ) : (runsQuery.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet. Hit “Run” to execute this workflow.</p>
          ) : (
            <div className="space-y-3">
              {(runsQuery.data ?? []).slice(0, 5).map((run: AgentWorkflowRun) => (
                <div key={run.id} className="rounded-md bg-muted/40 p-2">
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                    <span className="text-muted-foreground">
                      {new Date(run.startedAt).toLocaleString()} · {run.trigger}
                    </span>
                  </div>
                  <ol className="space-y-0.5">
                    {run.stepResults.map((sr) => (
                      <li key={sr.stepId} className="flex items-center gap-2 text-xs">
                        <ConnectorChip connector={sr.connector} />
                        <span className="font-medium">{sr.name}</span>
                        <span className="text-muted-foreground">— {sr.detail}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
