import { useId, useState, type ReactNode } from "react";
import type { Issue, RoutineDetail, RoutineTrigger } from "@paperclipai/shared";
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  GitBranch,
  History,
  KeyRound,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Radar,
  ScrollText,
  Sparkles,
  Terminal,
  Trash2,
  Webhook,
} from "lucide-react";
import { AgentAvatar, type AvatarAgent } from "@/components/AgentAvatar";
import { RunButton } from "@/components/AgentActionButtons";
import { MarkdownBody } from "@/components/MarkdownBody";
import { ScheduleEditor } from "@/components/ScheduleEditor";
import { TaskSummaryList } from "@/components/TaskSummaryList";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { deriveInitials } from "@/components/Identity";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
  ROUTINE_STATE_LABELS,
  WEBHOOK_HEALTH_LABELS,
  customRunRules,
  describeScheduleTrigger,
  formatNextRun,
  instructionsPreview,
  nextScheduledRun,
  routineAutomationState,
  routinePausedNotice,
  routineStatusDetail,
  webhookHealth,
  webhookTitle,
} from "./routine-summary";

export type RoutinePerson = { id: string; name: string; avatarUrl?: string | null };
export type RoutinePageAgent = AvatarAgent & { id: string; name: string; urlKey?: string | null };
export type RoutinePageProject = { id: string; name: string; color?: string | null; urlKey?: string | null };

/** A responsibility this routine is under: linked itself, or through its project. */
export type RoutineResponsibility = {
  id: string;
  title: string;
  areaTitle?: string | null;
  via: "direct" | "project";
};

export type RoutineScheduleChange = { cronExpression: string; timezone: string };

export type RoutinePageProps = {
  routine: RoutineDetail;
  agent: RoutinePageAgent | null;
  project: RoutinePageProject | null;
  responsibleUser: RoutinePerson | null;
  /** Leave undefined while areas of responsibility are switched off; the field is then hidden. */
  responsibilities?: readonly RoutineResponsibility[];
  /** Tasks this routine created, newest first. Pass the pages loaded so far. */
  history: readonly Issue[];
  historyLoading?: boolean;
  /** Shown in place of the task list when History could not be loaded. */
  historyError?: ReactNode;
  /** More tasks exist beyond the loaded pages. */
  hasMoreHistory?: boolean;
  loadingMoreHistory?: boolean;
  onLoadMoreHistory?: () => void;
  /** Recent runs that made no task because an earlier run was still working. */
  skippedRunCount?: number;
  /** Open comments on the instructions. */
  instructionCommentCount?: number;
  statusPending?: boolean;
  onToggleActive: (active: boolean) => void;
  onEdit: () => void;
  onSaveSchedule: (triggerId: string, change: RoutineScheduleChange) => void;
  onRemoveSchedule: (triggerId: string) => void;
  onOpenWebhook: (trigger: RoutineTrigger) => void;
  /** Pauses or resumes one schedule, standing check or API trigger. Omit to hide Pause/Resume. */
  onSetTriggerPaused?: (triggerId: string, paused: boolean) => void;
  /** Removes a standing check or API trigger. Omit to keep those rows read-only. */
  onRemoveTrigger?: (trigger: RoutineTrigger) => void;
  /** Triggers removed from this page, offered back with Undo under Repeats. */
  removedTriggers?: readonly RoutineTrigger[];
  onRestoreTrigger?: (trigger: RoutineTrigger) => void;
  onOpenInstructionComments?: () => void;
  /** Show the whole instructions, e.g. while their comments are open. */
  instructionsExpanded?: boolean;
  /** Wraps the rendered instructions, e.g. with the comment layer that anchors to them. */
  renderInstructionsBody?: (body: ReactNode) => ReactNode;
  /** Router state for task links in History, so a task can lead back here. */
  historyLinkState?: unknown;
};

function Field({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  const headingId = useId();
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm text-muted-foreground">{label}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PersonAvatar({ person }: { person: RoutinePerson }) {
  return (
    <Avatar size="xs" aria-hidden="true">
      {person.avatarUrl ? <AvatarImage src={person.avatarUrl} alt="" /> : null}
      <AvatarFallback>{deriveInitials(person.name)}</AvatarFallback>
    </Avatar>
  );
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

const rowButtonClass =
  "group -mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ScheduleRow({
  trigger,
  routineActive,
  onSave,
  onRemove,
  onSetPaused,
}: {
  trigger: RoutineTrigger;
  routineActive: boolean;
  onSave: (change: RoutineScheduleChange) => void;
  onRemove: () => void;
  onSetPaused?: (paused: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cron, setCron] = useState(trigger.cronExpression ?? "0 9 * * 1-5");
  const [valid, setValid] = useState(true);
  const timezone = trigger.timezone ?? localTimezone();
  const dimmed = !trigger.enabled || !routineActive;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setCron(trigger.cronExpression ?? "0 9 * * 1-5");
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={rowButtonClass} aria-label={`Change schedule: ${describeScheduleTrigger(trigger)}`}>
          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn("min-w-0 flex-1 truncate font-medium", dimmed && "text-muted-foreground")}>
            {describeScheduleTrigger(trigger)}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{trigger.enabled ? timezone : "Paused"}</span>
        </button>
      </PopoverTrigger>
      {/* Wider when Pause/Resume joins Remove and Save, so the footer stays on one row. */}
      <PopoverContent align="start" className={cn("flex max-w-(--sz-calc-4) flex-col gap-4", onSetPaused ? "w-96" : "w-80")}>
        <ScheduleEditor value={cron} onChange={setCron} onValidityChange={setValid} />
        <p className="text-xs text-muted-foreground">Times are in {timezone}.</p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              Remove schedule
            </Button>
            {onSetPaused ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setOpen(false);
                  onSetPaused(trigger.enabled);
                }}
              >
                {trigger.enabled ? "Pause" : "Resume"}
              </Button>
            ) : null}
          </div>
          <Button
            size="sm"
            disabled={!valid}
            onClick={() => {
              setOpen(false);
              onSave({ cronExpression: cron, timezone });
            }}
          >
            Save schedule
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WebhookRow({
  trigger,
  routineActive,
  onOpen,
}: {
  trigger: RoutineTrigger;
  routineActive: boolean;
  onOpen: () => void;
}) {
  const health = webhookHealth(trigger);
  const ignored = !routineActive && health !== "setup" && health !== "testing";
  const Icon = trigger.signingMode === "github_hmac" ? GitBranch : Webhook;
  return (
    <button type="button" className={rowButtonClass} onClick={onOpen} aria-label={`Open ${webhookTitle(trigger)}`}>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className={cn("min-w-0 flex-1 truncate font-medium", (ignored || health === "paused") && "text-muted-foreground")}>
        {webhookTitle(trigger)}
      </span>
      <span className={cn("shrink-0 text-xs", health === "rejected" && !ignored ? "text-destructive" : "text-muted-foreground")}>
        {ignored ? "Ignoring events" : WEBHOOK_HEALTH_LABELS[health]}
      </span>
    </button>
  );
}

/** A standing check or API trigger: nothing to configure, but it can be paused or removed. */
function StaticTriggerRow({
  icon: Icon,
  title,
  detail,
  description,
  trigger,
  routineActive,
  onSetPaused,
  onRemove,
}: {
  icon: typeof Radar;
  title: string;
  detail: string;
  description: string;
  trigger: RoutineTrigger;
  routineActive: boolean;
  onSetPaused?: (paused: boolean) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dimmed = !trigger.enabled || !routineActive;
  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className={cn("min-w-0 flex-1 truncate font-medium", dimmed && "text-muted-foreground")}>{title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{trigger.enabled ? detail : "Paused"}</span>
    </>
  );
  if (!onSetPaused && !onRemove) {
    return <div className="flex min-w-0 items-center gap-2 py-1.5 text-sm">{content}</div>;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={rowButtonClass} aria-label={`Change ${title}`}>
          {content}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 flex-col gap-4">
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex items-center justify-between gap-2">
          {onRemove ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              Remove
            </Button>
          ) : <span />}
          {onSetPaused ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(false);
                onSetPaused(trigger.enabled);
              }}
            >
              {trigger.enabled ? "Pause" : "Resume"}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** How a removed trigger is named in its "removed. Undo" line. */
export function triggerTitle(trigger: RoutineTrigger): string {
  if (trigger.kind === "schedule") return describeScheduleTrigger(trigger);
  if (trigger.kind === "webhook") return webhookTitle(trigger);
  if (trigger.kind === "heartbeat") return "Standing check";
  return "API trigger";
}

function Instructions({
  markdown,
  commentCount = 0,
  onOpenComments,
  onEdit,
  forceExpanded = false,
  renderBody = (body) => body,
}: {
  markdown: string;
  commentCount?: number;
  onOpenComments?: () => void;
  onEdit: () => void;
  forceExpanded?: boolean;
  renderBody?: (body: ReactNode) => ReactNode;
}) {
  const [expandedState, setExpanded] = useState(false);
  const expanded = expandedState || forceExpanded;
  const [copied, setCopied] = useState(false);
  const { preview, truncated } = instructionsPreview(markdown);
  const empty = markdown.trim().length === 0;

  return (
    <Field
      label="Instructions"
      action={empty ? null : (
        <div className="flex items-center gap-1">
          {commentCount > 0 ? (
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onOpenComments}>
              <MessageSquare />
              {commentCount} {commentCount === 1 ? "comment" : "comments"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label={copied ? "Instructions copied" : "Copy instructions"}
            onClick={async () => {
              await copyTextToClipboard(markdown);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      )}
    >
      {empty ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">No instructions yet. The agent only gets the title.</p>
          <Button variant="outline" size="sm" onClick={onEdit}>Add instructions</Button>
        </div>
      ) : (
        <>
          {/* Comments anchor to the full text, so the comment layer only wraps it when the whole text shows. */}
          {expanded || !truncated
            ? renderBody(
                <MarkdownBody className="text-sm text-foreground" linkIssueReferences>
                  {markdown}
                </MarkdownBody>,
              )
            : (
                <MarkdownBody className="text-sm text-foreground" linkIssueReferences>
                  {preview}
                </MarkdownBody>
              )}
          {truncated && !forceExpanded ? (
            <Button
              variant="ghost"
              size="sm"
              className="-mx-2 w-fit"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show all"}
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
            </Button>
          ) : null}
        </>
      )}
    </Field>
  );
}

export function RoutinePage({
  routine,
  agent,
  project,
  responsibleUser,
  responsibilities,
  history,
  historyLoading = false,
  historyError,
  hasMoreHistory = false,
  loadingMoreHistory = false,
  onLoadMoreHistory,
  skippedRunCount = 0,
  instructionCommentCount,
  statusPending = false,
  onToggleActive,
  onEdit,
  onSaveSchedule,
  onRemoveSchedule,
  onSetTriggerPaused,
  onRemoveTrigger,
  removedTriggers = [],
  onRestoreTrigger,
  onOpenWebhook,
  onOpenInstructionComments,
  instructionsExpanded = false,
  renderInstructionsBody,
  historyLinkState,
}: RoutinePageProps) {
  const state = routineAutomationState(routine);
  const schedules = routine.triggers.filter((trigger) => trigger.kind === "schedule");
  const webhooks = routine.triggers.filter((trigger) => trigger.kind === "webhook");
  const standingCheck = routine.triggers.find((trigger) => trigger.kind === "heartbeat");
  const apiTrigger = routine.triggers.find((trigger) => trigger.kind === "api");
  const nextRun = state === "active" ? nextScheduledRun(routine.triggers) : null;
  const hasEnabledWebhook = webhooks.some((trigger) => trigger.enabled && !trigger.setupPending);
  const runRules = customRunRules(routine);
  const secretNames = Object.keys(routine.env ?? {});
  const archived = state === "archived";
  const active = state === "active";
  const hasSchedule = schedules.some((trigger) => trigger.enabled);
  const pausedNotice = routinePausedNotice({ state, hasWebhooks: webhooks.length > 0, hasSchedule });
  const statusDetail = routineStatusDetail({ state, nextRun, hasEnabledWebhook, hasStandingCheck: Boolean(standingCheck) });

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-x-12 gap-y-10 px-4 py-8 md:px-8 lg:grid-cols-5">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-xl font-semibold text-balance">{routine.title}</h1>
          {routine.managedByPlugin ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              Managed by {routine.managedByPlugin.pluginDisplayName}
            </p>
          ) : null}
        </div>

        <Field label="Status">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <ToggleSwitch
              checked={state === "active"}
              onCheckedChange={onToggleActive}
              disabled={statusPending || archived || state === "draft"}
              aria-label={state === "active" ? "Pause this routine" : "Turn this routine on"}
            />
            <span className={cn("text-sm font-medium", state !== "active" && "text-muted-foreground")}>
              {ROUTINE_STATE_LABELS[state]}
            </span>
            {statusDetail ? <span className="text-sm text-muted-foreground">{statusDetail}</span> : null}
          </div>
          {pausedNotice ? <p className="text-sm text-muted-foreground" role="note">{pausedNotice}</p> : null}
          {state === "draft" ? (
            <p className="text-sm text-muted-foreground">
              <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={onEdit}>
                Choose a default agent
              </button>{" "}
              to turn this routine on.
            </p>
          ) : null}
        </Field>

        <Field label="Repeats">
          <div className="flex min-w-0 flex-col">
            {schedules.map((trigger) => (
              <ScheduleRow
                key={trigger.id}
                trigger={trigger}
                routineActive={active}
                onSave={(change) => onSaveSchedule(trigger.id, change)}
                onRemove={() => onRemoveSchedule(trigger.id)}
                onSetPaused={onSetTriggerPaused ? (paused) => onSetTriggerPaused(trigger.id, paused) : undefined}
              />
            ))}
            {webhooks.map((trigger) => (
              <WebhookRow key={trigger.id} trigger={trigger} routineActive={active} onOpen={() => onOpenWebhook(trigger)} />
            ))}
            {standingCheck ? (
              <StaticTriggerRow
                icon={Radar}
                title="Standing check"
                detail="Each time the agent wakes up"
                description="The agent carries out these instructions each time it wakes up and reports what it found. It never creates a task by itself."
                trigger={standingCheck}
                routineActive={active}
                onSetPaused={onSetTriggerPaused ? (paused) => onSetTriggerPaused(standingCheck.id, paused) : undefined}
                onRemove={onRemoveTrigger ? () => onRemoveTrigger(standingCheck) : undefined}
              />
            ) : null}
            {apiTrigger ? (
              <StaticTriggerRow
                icon={Terminal}
                title="API"
                detail="Started by an API call"
                description="Starts this routine when an app or agent calls the routine API."
                trigger={apiTrigger}
                routineActive={active}
                onSetPaused={onSetTriggerPaused ? (paused) => onSetTriggerPaused(apiTrigger.id, paused) : undefined}
                onRemove={onRemoveTrigger ? () => onRemoveTrigger(apiTrigger) : undefined}
              />
            ) : null}
            {removedTriggers.map((trigger) => (
              <p key={trigger.id} role="status" className="flex min-w-0 items-center gap-2 py-1.5 text-sm text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{triggerTitle(trigger)} removed.</span>
                {onRestoreTrigger ? (
                  <Button type="button" variant="ghost" size="xs" onClick={() => onRestoreTrigger(trigger)}>Undo</Button>
                ) : null}
              </p>
            ))}
            {routine.triggers.length === 0 && removedTriggers.length === 0 ? (
              <p className="py-1.5 text-sm text-muted-foreground">Doesn’t repeat. Runs only when you start it.</p>
            ) : null}
          </div>
        </Field>

        <Field label="Default agent">
          {agent ? (
            <Link
              to={`/agents/${agent.urlKey ?? agent.id}`}
              className="flex w-fit max-w-full items-center gap-2 py-1.5 text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <AgentAvatar agent={agent} size={20} className="shrink-0" />
              <span className="truncate">{agent.name}</span>
            </Link>
          ) : (
            <Button variant="outline" size="sm" className="w-fit" onClick={onEdit}>Choose an agent</Button>
          )}
        </Field>

        <Field label="Default responsible user">
          {responsibleUser ? (
            <p className="flex min-w-0 items-center gap-2 py-1.5 text-sm font-medium">
              <PersonAvatar person={responsibleUser} />
              <span className="truncate">{responsibleUser.name}</span>
            </p>
          ) : (
            <p className="py-1.5 text-sm text-muted-foreground">No one yet</p>
          )}
        </Field>

        <Field label="Project">
          {project ? (
            <Link
              to={`/projects/${project.urlKey ?? project.id}`}
              className="flex w-fit max-w-full items-center gap-2 py-1.5 text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="h-3.5 w-3.5 shrink-0 rounded-sm" style={{ backgroundColor: project.color ?? "var(--project-none)" }} aria-hidden="true" />
              <span className="truncate">{project.name}</span>
            </Link>
          ) : (
            <p className="py-1.5 text-sm text-muted-foreground">No project</p>
          )}
        </Field>

        {responsibilities ? (
          <Field label="Responsibility">
            {responsibilities.length === 0 ? (
              <p className="py-1.5 text-sm text-muted-foreground">None</p>
            ) : (
              <ul className="flex min-w-0 flex-col">
                {responsibilities.map((responsibility) => (
                  <li key={responsibility.id} className="flex min-w-0 items-baseline gap-2 py-1.5 text-sm">
                    <Link
                      to={`/responsibilities/${responsibility.id}`}
                      className="min-w-0 truncate font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {responsibility.title}
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {responsibility.via === "project" && project
                        ? `Through ${project.name}`
                        : responsibility.areaTitle ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        ) : null}

        {routine.variables.length > 0 ? (
          <Field label="Asks for">
            <ul className="flex min-w-0 flex-col gap-1.5 py-1.5">
              {routine.variables.map((variable) => (
                <li key={variable.name} className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className="truncate font-medium">{variable.label || variable.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {variable.defaultValue != null && variable.defaultValue !== ""
                      ? `Usually ${String(variable.defaultValue)}`
                      : variable.required
                        ? "Required"
                        : "Optional"}
                  </span>
                </li>
              ))}
            </ul>
          </Field>
        ) : null}

        {secretNames.length > 0 ? (
          <Field label="Secrets">
            <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 py-1.5">
              {secretNames.map((name) => (
                <li key={name} className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{name}</span>
                </li>
              ))}
            </ul>
          </Field>
        ) : null}

        {runRules.length > 0 ? (
          <Field label="Run rules">
            <ul className="flex flex-col gap-1 py-1.5 text-sm">
              {runRules.map((rule) => <li key={rule}>{rule}</li>)}
            </ul>
          </Field>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-8 lg:col-span-3">
        <Instructions
          markdown={routine.description ?? ""}
          commentCount={instructionCommentCount}
          onOpenComments={onOpenInstructionComments}
          onEdit={onEdit}
          forceExpanded={instructionsExpanded}
          renderBody={renderInstructionsBody}
        />

        <Field label="History">
          {historyError && history.length === 0 ? (
            historyError
          ) : historyLoading ? (
            <p className="py-1.5 text-sm text-muted-foreground" role="status">Loading tasks…</p>
          ) : history.length === 0 ? (
            <p className="py-1.5 text-sm text-muted-foreground">
              {state === "active" && nextRun
                ? `No tasks yet. The first one starts ${formatNextRun(nextRun)}.`
                : "No tasks yet. Each run creates a task here."}
            </p>
          ) : (
            <TaskSummaryList issues={history} label="Tasks created by this routine" issueLinkState={historyLinkState} />
          )}
          {historyError && history.length > 0 ? historyError : null}
          {hasMoreHistory && history.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="-mx-2 w-fit text-muted-foreground"
              disabled={loadingMoreHistory}
              onClick={onLoadMoreHistory}
            >
              {loadingMoreHistory ? "Loading…" : "Load more"}
            </Button>
          ) : null}
          {skippedRunCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {skippedRunCount === 1 ? "1 run was" : `${skippedRunCount} runs were`} folded into a task that was still in
              progress.
            </p>
          ) : null}
        </Field>
      </div>
    </div>
  );
}

/** Version history and the audit log open as their own view, with a way back to the routine. */
export function RoutineSubpage({
  routineTitle,
  title,
  onBack,
  children,
}: {
  routineTitle: string;
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-8">
      <div className="flex flex-col items-start gap-2">
        <Button variant="ghost" size="sm" className="-mx-2 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {routineTitle}
        </Button>
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export type RoutinePageActionsProps = {
  archived?: boolean;
  runPending?: boolean;
  /** Start with the menu open, for review. */
  defaultMenuOpen?: boolean;
  onEdit: () => void;
  onRunNow: () => void;
  onOpenVersionHistory: () => void;
  onOpenAuditLog: () => void;
  onArchive: () => void;
  onRestore?: () => void;
};

/** Header controls for the routine page: edit, a short overflow menu, and Run now. */
export function RoutinePageActions({
  archived = false,
  runPending = false,
  defaultMenuOpen = false,
  onEdit,
  onRunNow,
  onOpenVersionHistory,
  onOpenAuditLog,
  onArchive,
  onRestore,
}: RoutinePageActionsProps) {
  return (
    <div className="flex items-center gap-1">
      {archived ? null : (
        <Button variant="ghost" size="icon-sm" aria-label="Edit routine" onClick={onEdit}>
          <Pencil />
        </Button>
      )}
      <DropdownMenu defaultOpen={defaultMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More routine actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onOpenVersionHistory}>
            <History />
            Version history
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenAuditLog}>
            <ScrollText />
            Audit log
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {archived && onRestore ? (
            <DropdownMenuItem onSelect={onRestore}>Restore routine</DropdownMenuItem>
          ) : (
            <DropdownMenuItem variant="destructive" onSelect={onArchive}>
              <Trash2 />
              Archive routine
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {archived ? null : <RunButton onClick={onRunNow} disabled={runPending} />}
    </div>
  );
}
