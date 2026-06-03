import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { GitBranch, Play, Plus, Sparkles, Workflow as WorkflowIcon } from "lucide-react";
import type { WorkflowListItem } from "@paperclipai/shared";
import { workflowsApi } from "../api/workflows";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type WorkflowCreateDraft = {
  title: string;
  description: string;
  agentPath: string;
  cwd: string;
  command: string;
  model: string;
};

const defaultDraft: WorkflowCreateDraft = {
  title: "",
  description: "",
  agentPath: "",
  cwd: "",
  command: "",
  model: "",
};

export function Workflows() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<WorkflowCreateDraft>(defaultDraft);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const workflowsQuery = useQuery({
    queryKey: queryKeys.workflows.list(selectedCompanyId ?? ""),
    queryFn: () => workflowsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: (query) => {
      const items = (query.state.data ?? []) as WorkflowListItem[];
      return items.some((item) => item.latestRun && ["queued", "running", "awaiting_human"].includes(item.latestRun.status))
        ? 4000
        : false;
    },
  });

  const createMutation = useMutation({
    mutationFn: () => workflowsApi.create(selectedCompanyId!, {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      runnerConfig: {
        agentPath: draft.agentPath.trim(),
        ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
        ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      },
    }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflows.list(selectedCompanyId!) });
      setDraft(defaultDraft);
      pushToast({ title: "Workflow created", body: created.title, tone: "success" });
      navigate(`/workflows/${created.id}`);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create workflow",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const items = workflowsQuery.data ?? [];
  const activeCount = useMemo(
    () => items.filter((item) => item.latestRun && ["queued", "running", "awaiting_human"].includes(item.latestRun.status)).length,
    [items],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={WorkflowIcon} message="Select a company to manage workflows." />;
  }

  if (workflowsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Company-scoped ADK automations with live pipeline runs and workflow-backed deliverables.
            {items.length > 0 ? ` ${items.length} total, ${activeCount} active.` : ""}
          </p>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">Create workflow</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="workflow-title">Title</Label>
            <Input
              id="workflow-title"
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="Customer report generator"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workflow-model">Model</Label>
            <Input
              id="workflow-model"
              value={draft.model}
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
              placeholder="gemini-2.5-pro"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="workflow-description">Description</Label>
            <Textarea
              id="workflow-description"
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="What this workflow accepts and what it delivers."
              rows={3}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="workflow-agent-path">ADK path</Label>
            <Input
              id="workflow-agent-path"
              value={draft.agentPath}
              onChange={(event) => setDraft((current) => ({ ...current, agentPath: event.target.value }))}
              placeholder="/absolute/path/to/adk/project"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workflow-cwd">Working directory</Label>
            <Input
              id="workflow-cwd"
              value={draft.cwd}
              onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))}
              placeholder="Optional override"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workflow-command">Command override</Label>
            <Input
              id="workflow-command"
              value={draft.command}
              onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
              placeholder="Optional runner command"
            />
          </div>
          <div className="md:col-span-2 flex justify-end">
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || !draft.title.trim() || !draft.agentPath.trim()}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Create workflow
            </Button>
          </div>
        </CardContent>
      </Card>

      {workflowsQuery.error ? (
        <p className="text-sm text-destructive">
          {(workflowsQuery.error as Error).message}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          message="No workflows yet. Create one and point it at a Google ADK project to generate its first pipeline."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {items.map((item) => (
            <WorkflowCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowCard({ item }: { item: WorkflowListItem }) {
  return (
    <Link to={`/workflows/${item.id}`} className="no-underline text-inherit">
      <Card className="h-full transition-colors hover:border-foreground/30">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">{item.title}</h2>
              </div>
              {item.description ? (
                <p className="text-sm text-muted-foreground line-clamp-2">{item.description}</p>
              ) : null}
            </div>
            <StatusPill status={item.status} />
          </div>

          <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
              <span>Pipeline</span>
              <span>{item.pipelineDefinition.phases.length} phases</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {item.pipelineDefinition.phases.slice(0, 4).map((phase) => {
                const isCurrent = item.currentPhase?.phaseKey === phase.key;
                return (
                  <div
                    key={phase.key}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      isCurrent ? "border-amber-500 bg-amber-500/10 text-amber-100 animate-pulse" : "border-border bg-background"
                    }`}
                  >
                    {phase.label}
                  </div>
                );
              })}
              {item.pipelineDefinition.phases.length > 4 ? (
                <div className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
                  +{item.pipelineDefinition.phases.length - 4} more
                </div>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <InfoBlock
              icon={<Play className="h-3.5 w-3.5" />}
              label="Latest run"
              value={item.latestRun ? item.latestRun.status.replaceAll("_", " ") : "Never"}
              hint={item.latestRun ? relativeTime(item.latestRun.createdAt) : null}
            />
            <InfoBlock
              icon={<GitBranch className="h-3.5 w-3.5" />}
              label="Current phase"
              value={item.currentPhase?.label ?? "Idle"}
              hint={item.currentPhase ? `#${item.currentPhase.ordinal + 1}` : null}
            />
            <InfoBlock
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Latest deliverable"
              value={item.latestDeliverable?.title ?? "None"}
              hint={item.latestDeliverable ? formatDateTime(item.latestDeliverable.createdAt) : null}
            />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function InfoBlock({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string | null;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "active"
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
    : status === "paused"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
      : "border-border bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${tone}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}
