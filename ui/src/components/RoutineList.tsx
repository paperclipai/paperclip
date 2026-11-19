import type { AgentAppearance } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import type { MouseEvent, ReactNode } from "react";
import { MoreHorizontal, Play, LoaderCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Identity } from "./Identity";
import type { CompanyUserProfile } from "@/lib/company-members";
import { routineColumnGrid, type RoutineColumn } from "./RoutineTable";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

export type RoutineListProjectSummary = {
  name: string;
  color?: string | null;
};

export type RoutineListAgentSummary = {
  id?: string;
  appearance?: AgentAppearance | null;
  name: string;
  icon?: string | null;
};

export type RoutineListRowItem = {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  responsibleUserId?: string | null;
  lastRun?: {
    triggeredAt?: Date | string | null;
    status?: string | null;
  } | null;
};

export function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export function formatRoutineRunStatus(value: string | null | undefined) {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

export function nextRoutineStatus(currentStatus: string, enabled: boolean) {
  if (currentStatus === "archived" && enabled) return "active";
  return enabled ? "active" : "paused";
}

type RoutineRowProps<TRoutine extends RoutineListRowItem> = {
  routine: TRoutine;
  userById?: Map<string, CompanyUserProfile>;
  projectById: Map<string, RoutineListProjectSummary>;
  agentById: Map<string, RoutineListAgentSummary>;
  runningRoutineId: string | null;
  statusMutationRoutineId: string | null;
  href: string;
  configureLabel?: string;
  managedByLabel?: string | null;
  secondaryDetails?: ReactNode;
  runNowButton?: boolean;
  disableRunNow?: boolean;
  disableToggle?: boolean;
  hideArchiveAction?: boolean;
  /** Render a bottom divider between consecutive rows. Off when the group is its own card. */
  divider?: boolean;
  selected?: boolean;
  selectMode?: boolean;
  extraMenuItems?: ReactNode;
  onSelectChange?: (routine: TRoutine, selected: boolean) => void;
  onRunNow: (routine: TRoutine) => void;
  onToggleEnabled: (routine: TRoutine, enabled: boolean) => void;
  onToggleArchived?: (routine: TRoutine) => void;
};

function openRoutineFromRow(event: MouseEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if ((event.target as Element).closest("a, button, input, [role='switch'], [role='checkbox']")) return;
  event.currentTarget.querySelector<HTMLAnchorElement>("[data-routine-link]")?.click();
}

function routineRowParts<TRoutine extends RoutineListRowItem>({
  routine,
  userById,
  projectById,
  agentById,
  runningRoutineId,
  statusMutationRoutineId,
  href,
  configureLabel = "Edit",
  managedByLabel,
  secondaryDetails,
  runNowButton = false,
  disableRunNow = false,
  disableToggle = false,
  hideArchiveAction = false,
  selected = false,
  extraMenuItems,
  onSelectChange,
  onRunNow,
  onToggleEnabled,
  onToggleArchived,
}: RoutineRowProps<TRoutine>) {
  const enabled = routine.status === "active";
  const isArchived = routine.status === "archived";
  const isStatusPending = statusMutationRoutineId === routine.id;
  const project = routine.projectId ? projectById.get(routine.projectId) ?? null : null;
  const agent = routine.assigneeAgentId ? agentById.get(routine.assigneeAgentId) ?? null : null;
  const isDraft = !isArchived && !routine.assigneeAgentId;
  const runDisabled = runningRoutineId === routine.id || isArchived || disableRunNow;

  const user = routine.responsibleUserId ? userById?.get(routine.responsibleUserId) : null;
  const projectCell = <span className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: project?.color ?? "var(--project-none)" }} /><span className="truncate">{routine.projectId ? project?.name ?? "Unknown project" : "No project"}</span></span>;
  const agentCell = <span className="flex min-w-0 items-center gap-2">{routine.assigneeAgentId ? <AgentAvatar agent={{ ...agent, id: routine.assigneeAgentId }} size={16} className="h-3.5 w-3.5 shrink-0" /> : null}<span className="truncate">{routine.assigneeAgentId ? agent?.name ?? "Unknown agent" : "No default agent"}</span></span>;
  const userCell = user ? <Identity name={user.label} avatarUrl={user.image} size="sm" /> : <span>{routine.responsibleUserId ? "Unavailable user" : "No responsible user"}</span>;
  const lastRunCell = <span>{formatLastRunTimestamp(routine.lastRun?.triggeredAt)}{routine.lastRun ? ` · ${formatRoutineRunStatus(routine.lastRun.status)}` : ""}</span>;
  const enabledCell = <div className="flex items-center gap-2" onClick={event => { event.preventDefault(); event.stopPropagation(); }}><ToggleSwitch size="lg" checked={enabled} onCheckedChange={() => onToggleEnabled(routine, enabled)} disabled={isStatusPending || isArchived || disableToggle} aria-label={enabled ? `Disable ${routine.title}` : `Enable ${routine.title}`} /><span className="text-xs text-muted-foreground">{isArchived ? "Archived" : isDraft ? "Draft" : enabled ? "On" : "Off"}</span></div>;
  const cellByColumn = { project: projectCell, assignee: agentCell, responsibleUser: userCell, lastRun: lastRunCell, enabled: enabledCell };
  const title = (
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link data-routine-link to={href} className="truncate text-sm font-medium no-underline text-inherit">{routine.title}</Link>
          {(isArchived || routine.status === "paused" || isDraft) ? (
            <span className="text-xs text-muted-foreground">
              {isArchived ? "archived" : isDraft ? "draft" : "paused"}
            </span>
          ) : null}
          {managedByLabel ? (
            <span className="text-xs text-muted-foreground">{managedByLabel}</span>
          ) : null}
        </div>
        {secondaryDetails ? (
          <div className="text-xs text-muted-foreground">{secondaryDetails}</div>
        ) : null}
      </div>
  );
  const selection = (
<div
          className="flex items-start pt-0.5 sm:pt-1"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={selected}
            aria-label={`Select ${routine.title}`}
            onChange={(event) => onSelectChange?.(routine, event.target.checked)}
          />
        </div>
  );
  const actions = (
      <div className="flex items-center justify-end gap-3" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        {runNowButton ? (
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={runningRoutineId === routine.id ? `Running ${routine.title}` : `Run now: ${routine.title}`}
            title={runningRoutineId === routine.id ? "Running…" : "Run now"}
            disabled={runDisabled}
            onClick={() => onRunNow(routine)}
          >
            {runningRoutineId === routine.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          </Button>
        ) : null}



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
            {extraMenuItems ? (
              <>
                <DropdownMenuSeparator />
                {extraMenuItems}
              </>
            ) : null}
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
  );
  return { title, selection, actions, cellByColumn };
}

export function RoutineTableRow<TRoutine extends RoutineListRowItem>(props: RoutineRowProps<TRoutine> & { columns: RoutineColumn[]; userById: Map<string, CompanyUserProfile> }) {
  const { title, selection, actions, cellByColumn } = routineRowParts(props);
  return <div role="row" onClick={openRoutineFromRow} style={{ gridTemplateColumns: routineColumnGrid(props.columns, props.selectMode) }} className={`routine-table-grid group cursor-pointer px-3 py-3 transition-colors hover:bg-accent/50${props.divider !== false ? " border-b border-border last:border-b-0" : ""}`}>
    {props.selectMode ? <div role="cell">{selection}</div> : null}
    <div role="cell" className="min-w-0">{title}</div>
    {props.columns.map(column => <div role="cell" key={column} className="min-w-0 truncate text-xs text-muted-foreground">{cellByColumn[column]}</div>)}
    <div role="cell">{actions}</div>
  </div>;
}

export function RoutineListRow<TRoutine extends RoutineListRowItem>(props: RoutineRowProps<TRoutine>) {
  const { title, selection, actions, cellByColumn } = routineRowParts(props);
  return <div onClick={openRoutineFromRow} className={`group flex flex-col gap-3 px-3 py-3 transition-colors hover:bg-accent/50 sm:flex-row sm:items-center cursor-pointer${props.divider !== false ? " border-b border-border last:border-b-0" : ""}`}>
    {props.selectMode ? selection : null}
    <div className="min-w-0 flex-1 space-y-1.5">
      {title}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">{cellByColumn.project}{cellByColumn.assignee}{props.userById ? cellByColumn.responsibleUser : null}{cellByColumn.lastRun}</div>
    </div>
    {cellByColumn.enabled}{actions}
  </div>;
}
