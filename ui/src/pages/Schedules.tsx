import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { taskCronsApi } from "../api/taskCrons";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime, agentRouteRef } from "../lib/utils";
import { cronPresetOptions } from "../lib/cron-presets";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CalendarClock,
  Clock3,
  ExternalLink,
  Pencil,
  Plus,
  Power,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Link } from "@/lib/router";
import type { TaskCronSchedule, TaskCronIssueMode, Agent } from "@paperclipai/shared";

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
] as const;

const ISSUE_MODE_LABELS: Record<TaskCronIssueMode, string> = {
  create_new: "Creates new issue",
  reuse_existing: "Reuses issue",
  reopen_existing: "Reopens issue",
};

function describeCron(expression: string): string | null {
  const match = cronPresetOptions.find((o) => o.expression === expression.trim());
  return match?.label ?? null;
}

const INITIAL_DRAFT = {
  name: "",
  agentId: "",
  expression: "0 9 * * 1-5",
  timezone: "UTC",
  issueMode: "create_new" as TaskCronIssueMode,
};

export function Schedules() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState(INITIAL_DRAFT);

  useEffect(() => {
    setBreadcrumbs([{ label: "Schedules" }]);
  }, [setBreadcrumbs]);

  const { data: schedules, isLoading } = useQuery({
    queryKey: queryKeys.taskCrons.company(selectedCompanyId!),
    queryFn: () => taskCronsApi.listCompanySchedules(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeAgents = useMemo(
    () => (agents ?? []).filter((a) => a.status === "active"),
    [agents],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const filtered = useMemo(() => {
    let list = schedules ?? [];
    if (agentFilter !== "all") list = list.filter((s) => s.agentId === agentFilter);
    if (statusFilter === "active") list = list.filter((s) => s.enabled);
    if (statusFilter === "disabled") list = list.filter((s) => !s.enabled);
    return list.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [schedules, agentFilter, statusFilter]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    return (schedules ?? [])
      .filter((s) => s.enabled && s.nextTriggerAt && new Date(s.nextTriggerAt).getTime() > now)
      .sort((a, b) => new Date(a.nextTriggerAt!).getTime() - new Date(b.nextTriggerAt!).getTime())
      .slice(0, 5);
  }, [schedules]);

  const agentsWithSchedules = useMemo(() => {
    const ids = [...new Set((schedules ?? []).map((s) => s.agentId))];
    return ids.sort((a, b) => {
      const nameA = agentMap.get(a)?.name ?? a;
      const nameB = agentMap.get(b)?.name ?? b;
      return nameA.localeCompare(nameB);
    });
  }, [schedules, agentMap]);

  const createMutation = useMutation({
    mutationFn: (d: typeof draft) =>
      taskCronsApi.createAgentSchedule(
        d.agentId,
        { name: d.name, expression: d.expression, timezone: d.timezone, issueMode: d.issueMode, enabled: true },
        selectedCompanyId!,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskCrons.company(selectedCompanyId!) });
      setComposerOpen(false);
      setDraft(INITIAL_DRAFT);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: Partial<{ name: string; expression: string; timezone: string; enabled: boolean; issueMode: TaskCronIssueMode }> }) =>
      taskCronsApi.updateSchedule(id, fields, selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskCrons.company(selectedCompanyId!) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => taskCronsApi.deleteSchedule(id, selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.taskCrons.company(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarClock} message="Select a company to view schedules." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const activeCount = (schedules ?? []).filter((s) => s.enabled).length;
  const canCreate = draft.name.trim().length > 0 && draft.agentId && draft.expression.trim().length > 0;

  const presetValue = cronPresetOptions.find((o) => o.expression === draft.expression.trim())?.id ?? "__custom__";

  return (
    <div className="space-y-4 animate-page-enter">
      {upcoming.length > 0 && (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-3">
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Upcoming</div>
          <div className="flex flex-col gap-1.5">
            {upcoming.map((s) => {
              const agent = agentMap.get(s.agentId);
              return (
                <div key={s.id} className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground font-mono w-24 shrink-0 text-right">
                    {s.nextTriggerAt ? relativeTime(s.nextTriggerAt) : "—"}
                  </span>
                  <span className="font-medium truncate">{s.name}</span>
                  {agent && (
                    <span className="text-muted-foreground flex items-center gap-1 shrink-0 ml-auto">
                      <AgentIcon icon={agent.icon} className="h-3 w-3" />
                      <span className="hidden sm:inline">{agent.name}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
          <Clock3 className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">{activeCount} active schedule{activeCount !== 1 ? "s" : ""}</span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={() => setComposerOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Schedule
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {agentsWithSchedules.length > 1 && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-[160px] h-8 text-xs">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agentsWithSchedules.map((id) => (
                  <SelectItem key={id} value={id}>
                    {agentMap.get(id)?.name ?? id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTER_OPTIONS.map(({ value, label }) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          message={
            (schedules ?? []).length === 0
              ? "No schedules yet. Create your first one."
              : "No schedules match the current filters."
          }
          action="New Schedule"
          onAction={() => setComposerOpen(true)}
        />
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border">
          {filtered.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              agent={agentMap.get(schedule.agentId)}
              isEditing={editingId === schedule.id}
              onStartEdit={() => setEditingId(schedule.id)}
              onCancelEdit={() => setEditingId(null)}
              onUpdate={(fields) => {
                updateMutation.mutate({ id: schedule.id, fields }, {
                  onSuccess: () => setEditingId(null),
                });
              }}
              onToggleEnabled={() => {
                updateMutation.mutate({ id: schedule.id, fields: { enabled: !schedule.enabled } });
              }}
              onDelete={() => deleteMutation.mutate(schedule.id)}
              updating={updateMutation.isPending && updateMutation.variables?.id === schedule.id}
              deleting={deleteMutation.isPending && deleteMutation.variables === schedule.id}
            />
          ))}
        </div>
      )}

      {/* New Schedule dialog */}
      <Dialog open={composerOpen} onOpenChange={(open) => { setComposerOpen(open); if (!open) setDraft(INITIAL_DRAFT); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New Schedule</DialogTitle>
            <DialogDescription>Create a recurring schedule for an agent.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Name</label>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                placeholder="Daily standup, Weekly review..."
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Agent</label>
              <Select value={draft.agentId} onValueChange={(v) => setDraft((d) => ({ ...d, agentId: v }))}>
                <SelectTrigger className="w-full text-sm">
                  <SelectValue placeholder="Select an agent..." />
                </SelectTrigger>
                <SelectContent>
                  {activeAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex items-center gap-2">
                        <AgentIcon icon={a.icon} className="h-4 w-4 shrink-0" />
                        {a.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Preset</label>
                <select
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  value={presetValue}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    if (nextId === "__custom__") return;
                    const preset = cronPresetOptions.find((o) => o.id === nextId);
                    if (preset) setDraft((d) => ({ ...d, expression: preset.expression }));
                  }}
                >
                  <option value="__custom__">Custom expression</option>
                  {cronPresetOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} ({option.expression})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Cron expression</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono"
                  value={draft.expression}
                  onChange={(e) => setDraft((d) => ({ ...d, expression: e.target.value }))}
                  placeholder="0 9 * * 1-5"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Timezone</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  value={draft.timezone}
                  onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Issue behavior</label>
                <select
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  value={draft.issueMode}
                  onChange={(e) => setDraft((d) => ({ ...d, issueMode: e.target.value as TaskCronIssueMode }))}
                >
                  <option value="create_new">Create a new issue each run</option>
                  <option value="reopen_existing">Reopen issue when done</option>
                  <option value="reuse_existing">Reuse existing issue</option>
                </select>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => { setComposerOpen(false); setDraft(INITIAL_DRAFT); }}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate(draft)}
              disabled={!canCreate || createMutation.isPending}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {createMutation.isPending ? "Creating..." : "Create Schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ScheduleRowProps {
  schedule: TaskCronSchedule;
  agent: Agent | undefined;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (fields: Partial<{ name: string; expression: string; timezone: string; issueMode: TaskCronIssueMode }>) => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
  updating: boolean;
  deleting: boolean;
}

function ScheduleRow({
  schedule,
  agent,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onUpdate,
  onToggleEnabled,
  onDelete,
  updating,
  deleting,
}: ScheduleRowProps) {
  const [name, setName] = useState(schedule.name);
  const [expression, setExpression] = useState(schedule.expression);
  const [timezone, setTimezone] = useState(schedule.timezone);
  const [issueMode, setIssueMode] = useState<TaskCronIssueMode>(schedule.issueMode);

  useEffect(() => {
    setName(schedule.name);
    setExpression(schedule.expression);
    setTimezone(schedule.timezone);
    setIssueMode(schedule.issueMode);
  }, [schedule]);

  const cronLabel = describeCron(schedule.expression);

  if (!isEditing) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            onClick={onToggleEnabled}
            disabled={updating}
            className={`shrink-0 p-1 rounded transition-colors ${
              schedule.enabled
                ? "text-primary hover:text-primary/80"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title={schedule.enabled ? "Disable schedule" : "Enable schedule"}
          >
            <Power className="h-3.5 w-3.5" />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-medium truncate ${!schedule.enabled ? "text-muted-foreground" : ""}`}>
                {schedule.name}
              </span>
              <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                {schedule.expression}
              </span>
              {cronLabel && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  ({cronLabel})
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
              <span>{ISSUE_MODE_LABELS[schedule.issueMode]}</span>
              <span>·</span>
              <span>{schedule.timezone}</span>
              <span>·</span>
              <span>
                next {schedule.nextTriggerAt ? relativeTime(schedule.nextTriggerAt) : "not scheduled"}
              </span>
              {schedule.lastTriggeredAt && (
                <>
                  <span>·</span>
                  <span>last ran {relativeTime(schedule.lastTriggeredAt)}</span>
                </>
              )}
              {schedule.issueId && (
                <>
                  <span>·</span>
                  <Link
                    to={`/issues/${schedule.issueId}`}
                    className="inline-flex items-center gap-0.5 underline hover:text-foreground"
                  >
                    linked issue
                    <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        {agent && (
          <Link
            to={`/agents/${agentRouteRef(agent)}`}
            className="shrink-0 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors no-underline"
            title={agent.name ?? undefined}
          >
            <AgentIcon icon={agent.icon} className="h-4 w-4" />
            <span className="hidden sm:inline max-w-[100px] truncate">{agent.name}</span>
          </Link>
        )}

        <div className="shrink-0 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onStartEdit}
            title="Edit schedule"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive"
            onClick={onDelete}
            disabled={deleting}
            title="Delete schedule"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  const dirty =
    name !== schedule.name ||
    expression !== schedule.expression ||
    timezone !== schedule.timezone ||
    issueMode !== schedule.issueMode;

  function handleSave() {
    const fields: Partial<{ name: string; expression: string; timezone: string; issueMode: TaskCronIssueMode }> = {};
    if (name !== schedule.name) fields.name = name.trim();
    if (expression !== schedule.expression) fields.expression = expression.trim();
    if (timezone !== schedule.timezone) fields.timezone = timezone.trim();
    if (issueMode !== schedule.issueMode) fields.issueMode = issueMode;
    if (Object.keys(fields).length > 0) {
      onUpdate(fields);
    } else {
      onCancelEdit();
    }
  }

  const presetValue = cronPresetOptions.find((o) => o.expression === expression.trim())?.id ?? "__custom__";

  return (
    <div className="px-4 py-3 bg-muted/10 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Name</label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Timezone</label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Preset</label>
          <select
            className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
            value={presetValue}
            onChange={(e) => {
              const nextId = e.target.value;
              if (nextId === "__custom__") return;
              const preset = cronPresetOptions.find((o) => o.id === nextId);
              if (preset) setExpression(preset.expression);
            }}
          >
            <option value="__custom__">Custom expression</option>
            {cronPresetOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} ({option.expression})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Cron expression</label>
          <input
            className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm font-mono"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            placeholder="0 9 * * 1-5"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Issue behavior</label>
        <select
          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm sm:w-auto"
          value={issueMode}
          onChange={(e) => setIssueMode(e.target.value as TaskCronIssueMode)}
        >
          <option value="reopen_existing">Reopen this issue when done</option>
          <option value="reuse_existing">Reuse this issue</option>
          <option value="create_new">Create a new issue each run</option>
        </select>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || updating || name.trim().length === 0 || expression.trim().length === 0}
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {updating ? "Saving..." : "Save"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancelEdit}>
          <X className="h-3.5 w-3.5 mr-1.5" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
