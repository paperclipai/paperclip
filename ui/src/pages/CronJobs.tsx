import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cronJobsApi } from "../api/cronJobs";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Identity } from "../components/Identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Clock,
  Plus,
  Play,
  Pencil,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Pause,
} from "lucide-react";
import type { CompanyCronJob, Agent } from "@paperclipai/shared";

function formatRelative(date: Date | string | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const future = diffMs > 0;

  if (absDiffMs < 60_000) return future ? "in < 1m" : "< 1m ago";
  if (absDiffMs < 3600_000) {
    const m = Math.round(absDiffMs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (absDiffMs < 86400_000) {
    const h = Math.round(absDiffMs / 3600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const days = Math.round(absDiffMs / 86400_000);
  return future ? `in ${days}d` : `${days}d ago`;
}

function CronJobRow({
  job,
  agents,
  companyId,
  onEdit,
  onDelete,
}: {
  job: CompanyCronJob;
  agents: Agent[];
  companyId: string;
  onEdit: (job: CompanyCronJob) => void;
  onDelete: (job: CompanyCronJob) => void;
}) {
  const queryClient = useQueryClient();
  const agent = agents.find((a) => a.id === job.agentId);

  const triggerMutation = useMutation({
    mutationFn: () => cronJobsApi.trigger(companyId, job.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cronJobs.list(companyId) });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: () =>
      cronJobsApi.update(companyId, job.id, { enabled: !job.enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cronJobs.list(companyId) });
    },
  });

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{job.name}</span>
              {job.enabled ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-green-600 border-green-600/30">
                  Active
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                  Disabled
                </Badge>
              )}
              {job.consecutiveErrors > 0 && (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                  {job.consecutiveErrors} error{job.consecutiveErrors !== 1 ? "s" : ""}
                </Badge>
              )}
            </div>

            {job.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{job.description}</p>
            )}

            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="font-mono bg-muted/50 px-1.5 py-0.5 rounded">{job.cronExpr}</span>
              {job.timezone !== "UTC" && <span>{job.timezone}</span>}
              {agent && (
                <span className="flex items-center gap-1">
                  <Identity name={agent.name} size="xs" />
                </span>
              )}
            </div>

            <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground">
              {job.lastRunAt && (
                <span className="flex items-center gap-1">
                  {job.lastRunStatus === "succeeded" ? (
                    <CheckCircle2 className="h-3 w-3 text-green-500" />
                  ) : job.lastRunStatus === "failed" ? (
                    <AlertCircle className="h-3 w-3 text-red-500" />
                  ) : null}
                  Last: {formatRelative(job.lastRunAt)}
                  {job.lastRunDurationMs != null && ` (${(job.lastRunDurationMs / 1000).toFixed(1)}s)`}
                </span>
              )}
              {job.nextRunAt && job.enabled && (
                <span>Next: {formatRelative(job.nextRunAt)}</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => triggerMutation.mutate()}
              disabled={triggerMutation.isPending}
              title="Run now"
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => toggleMutation.mutate()}
              disabled={toggleMutation.isPending}
              title={job.enabled ? "Disable" : "Enable"}
            >
              <Pause className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit(job)}
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(job)}
              title="Delete"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface CronJobFormData {
  name: string;
  description: string;
  agentId: string;
  cronExpr: string;
  timezone: string;
  staggerMs: number;
  enabled: boolean;
  message: string;
}

function CronJobFormDialog({
  open,
  onOpenChange,
  companyId,
  agents,
  editJob,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  agents: Agent[];
  editJob: CompanyCronJob | null;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CronJobFormData>({
    name: "",
    description: "",
    agentId: "",
    cronExpr: "",
    timezone: "UTC",
    staggerMs: 0,
    enabled: true,
    message: "",
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editJob) {
      setForm({
        name: editJob.name,
        description: editJob.description ?? "",
        agentId: editJob.agentId,
        cronExpr: editJob.cronExpr,
        timezone: editJob.timezone,
        staggerMs: editJob.staggerMs,
        enabled: editJob.enabled,
        message: (editJob.payload as Record<string, unknown>)?.message as string ?? "",
      });
    } else {
      setForm({
        name: "",
        description: "",
        agentId: agents[0]?.id ?? "",
        cronExpr: "",
        timezone: "UTC",
        staggerMs: 0,
        enabled: true,
        message: "",
      });
    }
    setError(null);
  }, [editJob, open, agents]);

  const createMutation = useMutation({
    mutationFn: (data: CronJobFormData) => {
      const payload: Record<string, unknown> = {};
      if (data.message.trim()) payload.message = data.message.trim();
      if (editJob) {
        return cronJobsApi.update(companyId, editJob.id, {
          name: data.name,
          description: data.description || null,
          cronExpr: data.cronExpr,
          timezone: data.timezone,
          staggerMs: data.staggerMs,
          enabled: data.enabled,
          payload,
        });
      }
      return cronJobsApi.create(companyId, {
        agentId: data.agentId,
        name: data.name,
        description: data.description || null,
        cronExpr: data.cronExpr,
        timezone: data.timezone,
        staggerMs: data.staggerMs,
        enabled: data.enabled,
        payload,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cronJobs.list(companyId) });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to save cron job");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.cronExpr.trim() || !form.agentId) {
      setError("Name, agent, and cron expression are required");
      return;
    }
    createMutation.mutate(form);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editJob ? "Edit Cron Job" : "New Cron Job"}</DialogTitle>
          <DialogDescription>
            {editJob
              ? "Update the schedule and configuration for this cron job."
              : "Schedule a recurring task for an agent using a cron expression."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <input
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Nightly maintenance"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Agent</label>
            <select
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              value={form.agentId}
              onChange={(e) => setForm({ ...form, agentId: e.target.value })}
              disabled={!!editJob}
            >
              <option value="">Select agent...</option>
              {agents
                .filter((a) => a.status !== "terminated" && a.status !== "pending_approval")
                .map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Cron Expression
            </label>
            <input
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
              value={form.cronExpr}
              onChange={(e) => setForm({ ...form, cronExpr: e.target.value })}
              placeholder="*/5 * * * *"
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              min hour day month weekday (e.g. "0 9 * * 1-5" = 9am weekdays)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Timezone</label>
              <input
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                placeholder="UTC"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Stagger (ms)</label>
              <input
                type="number"
                min={0}
                max={300000}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                value={form.staggerMs}
                onChange={(e) => setForm({ ...form, staggerMs: Number(e.target.value) || 0 })}
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Message (agent prompt)
            </label>
            <textarea
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm min-h-[60px] resize-y"
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="Instructions passed to the agent on each run..."
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <input
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Optional description"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="cron-enabled"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="rounded border-input"
            />
            <label htmlFor="cron-enabled" className="text-sm">
              Enabled
            </label>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Saving..." : editJob ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirmDialog({
  open,
  onOpenChange,
  job,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: CompanyCronJob | null;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () => cronJobsApi.remove(companyId, job!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cronJobs.list(companyId) });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Cron Job</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete "{job?.name}"? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CronJobs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [formOpen, setFormOpen] = useState(false);
  const [editJob, setEditJob] = useState<CompanyCronJob | null>(null);
  const [deleteJob, setDeleteJob] = useState<CompanyCronJob | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Cron Jobs" }]);
  }, [setBreadcrumbs]);

  const { data: jobs, isLoading } = useQuery({
    queryKey: queryKeys.cronJobs.list(selectedCompanyId!),
    queryFn: () => cronJobsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Clock} message="Select a company to view cron jobs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  function handleEdit(job: CompanyCronJob) {
    setEditJob(job);
    setFormOpen(true);
  }

  function handleNew() {
    setEditJob(null);
    setFormOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Scheduled Jobs</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cron-based schedules that wake agents with specific instructions.
          </p>
        </div>
        <Button size="sm" onClick={handleNew}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Cron Job
        </Button>
      </div>

      {!jobs || jobs.length === 0 ? (
        <EmptyState
          icon={Clock}
          message="No cron jobs yet. Create one to schedule recurring agent tasks."
          action="New Cron Job"
          onAction={handleNew}
        />
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <CronJobRow
              key={job.id}
              job={job}
              agents={agents ?? []}
              companyId={selectedCompanyId}
              onEdit={handleEdit}
              onDelete={setDeleteJob}
            />
          ))}
        </div>
      )}

      <CronJobFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        companyId={selectedCompanyId}
        agents={agents ?? []}
        editJob={editJob}
      />

      <DeleteConfirmDialog
        open={!!deleteJob}
        onOpenChange={(open) => !open && setDeleteJob(null)}
        job={deleteJob}
        companyId={selectedCompanyId}
      />
    </div>
  );
}
