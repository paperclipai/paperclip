import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { AlertTriangle, Archive, GitBranch, Play, Plus, RotateCcw, Sparkles, Workflow as WorkflowIcon, X } from "lucide-react";
import type { WorkflowListItem } from "@paperclipai/shared";
import { workflowsApi } from "../api/workflows";
import { companyAwaitingHumanSettingsApi } from "../api/companyAwaitingHumanSettings";
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
import { StatusBadge } from "../components/StatusBadge";

type WorkflowCreateDraft = {
  title: string;
  description: string;
  agentPath: string;
  cwd: string;
  command: string;
  model: string;
};

type WorkflowFilter = "active" | "archived" | "all";

export function filterWorkflowItems(items: WorkflowListItem[], filter: WorkflowFilter) {
  return items.filter((item) => filter === "all" || (filter === "archived"
    ? item.status === "archived"
    : item.status !== "archived"));
}

export function getWorkflowEmptyStateMessage(items: WorkflowListItem[], filter: WorkflowFilter) {
  if (filter === "archived") return "No archived workflows.";
  if (items.length > 0) return "All workflows are archived. Switch to the Archived view to see them.";
  return "No workflows yet. Create one and point it at a Google ADK project to generate its first pipeline.";
}

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
  const [clickUpWarnDismissed, setClickUpWarnDismissed] = useState(false);
  const [workflowFilter, setWorkflowFilter] = useState<WorkflowFilter>("active");
  const [archiveConfirmationId, setArchiveConfirmationId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const awaitingHumanQuery = useQuery({
    queryKey: queryKeys.companies.awaitingHumanSettings(selectedCompanyId ?? ""),
    queryFn: () => companyAwaitingHumanSettingsApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });

  const clickUpNotConfigured = (() => {
    const s = awaitingHumanQuery.data;
    if (!s) return false;
    return !(
      s.enabled &&
      s.provider === "clickup" &&
      s.hasStoredAuthToken &&
      s.providerConfig?.workspaceId &&
      s.providerConfig?.channelId
    );
  })();

  const workflowsQuery = useQuery({
    queryKey: [...queryKeys.workflows.list(selectedCompanyId ?? ""), { includeArchived: true }],
    queryFn: () => workflowsApi.list(selectedCompanyId!, { includeArchived: true }),
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

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "archived" | "active" }) =>
      status === "archived" ? workflowsApi.archive(id) : workflowsApi.restore(id),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(updated.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.schedules(updated.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.activity(selectedCompanyId!, updated.id) }),
      ]);
      pushToast({
        title: updated.status === "archived" ? "Workflow archived" : "Workflow restored",
        body: updated.title,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update workflow status",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const items = workflowsQuery.data ?? [];
  const archivedCount = items.filter((item) => item.status === "archived").length;
  const visibleItems = useMemo(
    () => filterWorkflowItems(items, workflowFilter),
    [items, workflowFilter],
  );
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
      {clickUpNotConfigured && !clickUpWarnDismissed && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="flex-1">
            ClickUp integration is not fully configured. Workflows that use{" "}
            <code className="rounded bg-amber-500/20 px-1 py-0.5 text-xs font-mono">input()</code>{" "}
            handoffs will fail with a 503 until ClickUp is enabled.{" "}
            <Link to="/company/settings/awaiting-human" className="font-medium underline underline-offset-2 hover:text-amber-100">
              Configure in Company Settings
            </Link>
          </p>
          <button
            type="button"
            onClick={() => setClickUpWarnDismissed(true)}
            className="shrink-0 text-amber-400 hover:text-amber-200 transition-colors"
            aria-label="Dismiss warning"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Company-scoped ADK automations with live pipeline runs and workflow-backed deliverables.
            {items.length > 0 ? ` ${items.length} total, ${activeCount} active${archivedCount > 0 ? `, ${archivedCount} archived` : ""}.` : ""}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Show</span>
          <select
            value={workflowFilter}
            onChange={(event) => setWorkflowFilter(event.target.value as WorkflowFilter)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      <Card className="overflow-hidden rounded-xl">
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

      {visibleItems.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          message={getWorkflowEmptyStateMessage(items, workflowFilter)}
        />
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {visibleItems.map((item) => (
            <WorkflowCard
              key={item.id}
              item={item}
              archiveConfirmationOpen={archiveConfirmationId === item.id}
              onArchive={() => setArchiveConfirmationId(item.id)}
              onConfirmArchive={() => {
                setArchiveConfirmationId(null);
                statusMutation.mutate({ id: item.id, status: "archived" });
              }}
              onCancelArchive={() => setArchiveConfirmationId(null)}
              onRestore={() => statusMutation.mutate({ id: item.id, status: "active" })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowCard({
  item,
  archiveConfirmationOpen,
  onArchive,
  onConfirmArchive,
  onCancelArchive,
  onRestore,
}: {
  item: WorkflowListItem;
  archiveConfirmationOpen: boolean;
  onArchive: () => void;
  onConfirmArchive: () => void;
  onCancelArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <Card className="gap-0 rounded-xl py-0 transition-colors hover:border-foreground/30">
      <CardContent className="space-y-3 p-4 pb-3">
        <Link to={`/workflows/${item.id}`} className="block no-underline text-inherit">
          <div className="flex items-start justify-between gap-3 pb-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">{item.title}</h2>
              </div>
              {item.description ? (
                <p className="text-sm text-muted-foreground line-clamp-2">{item.description}</p>
              ) : null}
            </div>
            <StatusBadge status={item.status} />
          </div>

          <div className="border-y border-border/70 pb-4 pt-2.5">
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
                    className={`rounded-md border px-2.5 py-1 text-xs ${
                      isCurrent ? "border-amber-500/60 bg-amber-500/10 text-amber-100" : "border-border bg-muted/30 text-muted-foreground"
                    }`}
                  >
                    {phase.label}
                  </div>
                );
              })}
              {item.pipelineDefinition.phases.length > 4 ? (
                <div className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">
                  +{item.pipelineDefinition.phases.length - 4} more
                </div>
              ) : null}
            </div>
          </div>

          <div className="grid divide-y divide-border/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
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
        </Link>
      </CardContent>
      <footer className="border-t border-border/70 px-4 py-2">
        <div className="w-full">
          {archiveConfirmationOpen ? (
            <ArchiveConfirmation
              title={item.title}
              onConfirm={onConfirmArchive}
              onCancel={onCancelArchive}
            />
          ) : item.status === "archived" ? (
            <Button variant="outline" size="sm" onClick={onRestore}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Restore
            </Button>
          ) : (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={onArchive}>
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                Archive
              </Button>
            </div>
          )}
        </div>
      </footer>
    </Card>
  );
}

export function ArchiveConfirmation({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={`Archive workflow ${title}`} className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">Archive “{title}”?</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Runs and history remain available. New runs stop; in-flight runs finish.
        </p>
      </div>
      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="outline" size="sm" onClick={onConfirm}>Archive workflow</Button>
      </div>
    </div>
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
    <div className="min-w-0 px-3 py-1.5 first:pl-0 last:pr-0">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
