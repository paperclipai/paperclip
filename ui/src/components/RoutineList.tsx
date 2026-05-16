import type { ReactNode } from "react";
import { MoreHorizontal, Play } from "lucide-react";
import { Link } from "@/lib/router";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";

export type RoutineListProjectSummary = {
  name: string;
  color?: string | null;
};

export type RoutineListGoalSummary = {
  title: string;
};

export type RoutineListAgentSummary = {
  name: string;
  icon?: string | null;
};

export type RoutineListHealthBadge = {
  key: string;
  label: string;
  tone: "warning" | "danger";
};

type RoutineListIssueSummary = {
  id: string;
  identifier: string | null;
  status: string;
};

type RoutineListTriggerSummary = {
  id: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  nextRunAt?: Date | string | null;
};

export type RoutineListRowItem = {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  goalId?: string | null;
  assigneeAgentId: string | null;
  triggers?: RoutineListTriggerSummary[];
  lastRun?: {
    triggeredAt?: Date | string | null;
    status?: string | null;
    linkedIssue?: RoutineListIssueSummary | null;
    trigger?: Pick<RoutineListTriggerSummary, "id" | "kind" | "label"> | null;
  } | null;
  activeIssue?: RoutineListIssueSummary | null;
};

export function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export function formatRoutineRunStatus(value: string | null | undefined) {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

function formatTriggerKind(value: string | null | undefined) {
  if (!value) return "Trigger";
  return value.replaceAll("_", " ");
}

function formatTriggerLabel(trigger: RoutineListTriggerSummary | Pick<RoutineListTriggerSummary, "kind" | "label"> | null | undefined) {
  if (!trigger) return null;
  return trigger.label?.trim() || formatTriggerKind(trigger.kind);
}

function formatIssueStatus(value: string | null | undefined) {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

function findPrimaryTrigger(triggers: RoutineListTriggerSummary[]) {
  return triggers.find((trigger) => trigger.enabled) ?? triggers[0] ?? null;
}

function findNextRunAt(triggers: RoutineListTriggerSummary[]) {
  return triggers
    .filter((trigger) => trigger.enabled && trigger.nextRunAt)
    .map((trigger) => trigger.nextRunAt!)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] ?? null;
}

function issueHref(issue: RoutineListIssueSummary) {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function issueLabel(issue: RoutineListIssueSummary) {
  return issue.identifier ?? issue.id.slice(0, 8);
}

export function nextRoutineStatus(currentStatus: string, enabled: boolean) {
  if (currentStatus === "archived" && enabled) return "active";
  return enabled ? "active" : "paused";
}

export function RoutineListRow<TRoutine extends RoutineListRowItem>({
  routine,
  projectById,
  goalById,
  agentById,
  runningRoutineId,
  statusMutationRoutineId,
  href,
  configureLabel = "Edit",
  managedByLabel,
  secondaryDetails,
  healthBadges = [],
  runNowButton = false,
  disableRunNow = false,
  disableToggle = false,
  hideArchiveAction = false,
  onRunNow,
  onToggleEnabled,
  onToggleArchived,
}: {
  routine: TRoutine;
  projectById: Map<string, RoutineListProjectSummary>;
  goalById?: Map<string, RoutineListGoalSummary>;
  agentById: Map<string, RoutineListAgentSummary>;
  runningRoutineId: string | null;
  statusMutationRoutineId: string | null;
  href: string;
  configureLabel?: string;
  managedByLabel?: string | null;
  secondaryDetails?: ReactNode;
  healthBadges?: RoutineListHealthBadge[];
  runNowButton?: boolean;
  disableRunNow?: boolean;
  disableToggle?: boolean;
  hideArchiveAction?: boolean;
  onRunNow: (routine: TRoutine) => void;
  onToggleEnabled: (routine: TRoutine, enabled: boolean) => void;
  onToggleArchived?: (routine: TRoutine) => void;
}) {
  const enabled = routine.status === "active";
  const isArchived = routine.status === "archived";
  const isStatusPending = statusMutationRoutineId === routine.id;
  const project = routine.projectId ? projectById.get(routine.projectId) ?? null : null;
  const goal = routine.goalId ? goalById?.get(routine.goalId) ?? null : null;
  const agent = routine.assigneeAgentId ? agentById.get(routine.assigneeAgentId) ?? null : null;
  const isDraft = !isArchived && !routine.assigneeAgentId;
  const runDisabled = runningRoutineId === routine.id || isArchived || disableRunNow;
  const triggers = routine.triggers ?? [];
  const primaryTrigger = findPrimaryTrigger(triggers);
  const nextRunAt = findNextRunAt(triggers);
  const triggerCountSuffix = triggers.length > 1 ? ` +${triggers.length - 1}` : "";
  const lastRunLinkedIssue = routine.lastRun?.linkedIssue ?? null;
  const activeIssue = routine.activeIssue ?? null;

  return (
    <div className="flex flex-col gap-3 border-b border-border px-3 py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={href} className="truncate text-sm font-medium text-inherit no-underline hover:underline">
            {routine.title}
          </Link>
          {(isArchived || routine.status === "paused" || isDraft) ? (
            <span className="text-xs text-muted-foreground">
              {isArchived ? "archived" : isDraft ? "draft" : "paused"}
            </span>
          ) : null}
          {managedByLabel ? (
            <span className="text-xs text-muted-foreground">{managedByLabel}</span>
          ) : null}
          {healthBadges.map((badge) => (
            <Badge
              key={badge.key}
              variant={badge.tone === "danger" ? "destructive" : "outline"}
              className={cn(
                "h-5 px-1.5 text-xs font-medium",
                badge.tone === "warning" && "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
              )}
            >
              {badge.label}
            </Badge>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project?.color ?? "#64748b" }}
            />
            <span>{routine.projectId ? (project?.name ?? "Unknown project") : "No project"}</span>
          </span>
          <span className="min-w-0 truncate">
            Goal: {routine.goalId ? (goal?.title ?? "Unknown goal") : "No goal"}
          </span>
          <span className="flex items-center gap-2">
            {agent?.icon ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0" /> : null}
            <span>{routine.assigneeAgentId ? (agent?.name ?? "Unknown agent") : "No default agent"}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Trigger: {formatTriggerLabel(primaryTrigger) ?? "No triggers"}{triggerCountSuffix}
            {primaryTrigger && !primaryTrigger.enabled ? " (disabled)" : ""}
          </span>
          <span>Next: {formatLastRunTimestamp(nextRunAt)}</span>
          <span>
            Last: {formatLastRunTimestamp(routine.lastRun?.triggeredAt)}
            {routine.lastRun ? ` · ${formatRoutineRunStatus(routine.lastRun.status)}` : ""}
            {routine.lastRun?.trigger ? ` · ${formatTriggerLabel(routine.lastRun.trigger)}` : ""}
          </span>
          {lastRunLinkedIssue ? (
            <Link to={issueHref(lastRunLinkedIssue)} className="text-muted-foreground underline-offset-2 hover:underline">
              Last issue: {issueLabel(lastRunLinkedIssue)} · {formatIssueStatus(lastRunLinkedIssue.status)}
            </Link>
          ) : (
            <span>Last issue: none</span>
          )}
          {activeIssue ? (
            <Link to={issueHref(activeIssue)} className="text-muted-foreground underline-offset-2 hover:underline">
              Active: {issueLabel(activeIssue)} · {formatIssueStatus(activeIssue.status)}
            </Link>
          ) : (
            <span>Active: none</span>
          )}
        </div>
        {secondaryDetails ? (
          <div className="text-xs text-muted-foreground">{secondaryDetails}</div>
        ) : null}
      </div>

      <div className="flex items-center gap-3" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        {runNowButton ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={runDisabled}
            onClick={() => onRunNow(routine)}
          >
            <Play className="h-3.5 w-3.5" />
            {runningRoutineId === routine.id ? "Running..." : "Run now"}
          </Button>
        ) : null}

        <div className="flex items-center gap-3">
          <ToggleSwitch
            size="lg"
            checked={enabled}
            onCheckedChange={() => onToggleEnabled(routine, enabled)}
            disabled={isStatusPending || isArchived || disableToggle}
            aria-label={enabled ? `Disable ${routine.title}` : `Enable ${routine.title}`}
          />
          <span className="w-12 text-xs text-muted-foreground">
            {isArchived ? "Archived" : isDraft ? "Draft" : enabled ? "On" : "Off"}
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${routine.title}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to={href}>{configureLabel}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={runDisabled}
              onClick={() => onRunNow(routine)}
            >
              {runningRoutineId === routine.id ? "Running..." : "Run now"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onToggleEnabled(routine, enabled)}
              disabled={isStatusPending || isArchived || disableToggle}
            >
              {enabled ? "Pause" : "Enable"}
            </DropdownMenuItem>
            {!hideArchiveAction && onToggleArchived ? (
              <DropdownMenuItem
                onClick={() => onToggleArchived(routine)}
                disabled={isStatusPending}
              >
                {routine.status === "archived" ? "Restore" : "Archive"}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
