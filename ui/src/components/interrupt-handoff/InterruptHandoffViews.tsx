import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { AlertTriangle, Info, PauseCircle, User, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import {
  classifyAssigneeHandoff,
  resolveRunStatusPresentation,
  type ComposerHandoffPreview,
  type PauseAffectsSummary,
  type PlainAgentNameCandidate,
  type ReassignInterruptCopy,
  type TimelineAssigneeLike,
} from "../../lib/interrupt-handoff";

/**
 * Presentational views for the interrupt-handoff UX clarity surfaces (PAP-10669).
 * All logic lives in `lib/interrupt-handoff.ts`; these components only render it,
 * so they can be exercised in isolation by component tests and Storybook.
 */

export interface HandoffAgentLike {
  name: string;
  icon?: string | null;
}

export interface HandoffChipResolvers {
  agentMap?: ReadonlyMap<string, HandoffAgentLike> | null;
  resolveUserLabel?: (userId: string) => string | null;
  currentUserId?: string | null;
}

function agentName(agentId: string, resolvers: HandoffChipResolvers): string {
  return resolvers.agentMap?.get(agentId)?.name ?? agentId.slice(0, 8);
}

function agentIcon(agentId: string, resolvers: HandoffChipResolvers): string | null {
  return resolvers.agentMap?.get(agentId)?.icon ?? null;
}

function userLabel(userId: string, resolvers: HandoffChipResolvers): string {
  const label = resolvers.resolveUserLabel?.(userId) ?? null;
  const base = label ?? t("localizationActivityChrome.board");
  return resolvers.currentUserId && resolvers.currentUserId === userId ? t("localizationActivityChrome.youLabel", { name: base }) : base;
}

// Only known host-authored copy is translated; custom copy stays verbatim.
const HANDOFF_DISPLAY_KEYS: Record<string, string> = {
  "Interrupt the current run?": "localizationActivityChrome.interruptCurrent",
  "Interrupt & assign": "localizationActivityChrome.interruptAndAssign",
  "Cancel": "localizationActivityChrome.cancel",
  "Live agent runs": "localizationActivityChrome.pauseLiveRuns",
  "Queued wakes": "localizationActivityChrome.queuedWakes",
  "Agent-owned": "localizationActivityChrome.agentOwned",
  "Human-owned": "localizationActivityChrome.humanOwned",
  "Static": "localizationActivityChrome.staticTasks",
  "interrupted now, re-queued when you resume": "localizationActivityChrome.pauseLiveDetail",
  "held — they won't start until you resume": "localizationActivityChrome.pauseQueuedDetail",
  "responsible agent; no run is live": "localizationActivityChrome.pauseAgentDetail",
  "owned by a board user; pausing won't notify them": "localizationActivityChrome.pauseHumanDetail",
  "no responsible; nothing was going to run": "localizationActivityChrome.pauseStaticDetail",
};
function handoffText(text: string): string {
  return HANDOFF_DISPLAY_KEYS[text] ? t(HANDOFF_DISPLAY_KEYS[text]) : text;
}
function interruptBannerText(banner: string): string {
  const suffix = " is running — changing the responsible will interrupt this run.";
  if (!banner.endsWith(suffix)) return banner;
  const name = banner.slice(0, -suffix.length);
  return t("localizationActivityChrome.interruptBanner", { name: name === "An agent" ? t("localizationActivityChrome.anAgent") : name });
}

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs";

/** A labelled assignee chip — agent, user, or unassigned — that never lets a
 * user owner read like an agent. */
export function AssigneeChip({
  assignee,
  resolvers,
  className,
}: {
  assignee: TimelineAssigneeLike;
  resolvers: HandoffChipResolvers;
  className?: string;
}) {
  const { t } = useTranslation();
  if (assignee.agentId) {
    return (
      <span className={cn(CHIP_CLASS, className)} data-testid="handoff-assignee-chip" data-kind="agent">
        <span className="sr-only">{t("localizationActivityChrome.agentPrefix")}</span>
        <AgentIcon icon={agentIcon(assignee.agentId, resolvers)} className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="max-w-(--sz-12rem) truncate">{agentName(assignee.agentId, resolvers)}</span>
      </span>
    );
  }
  if (assignee.userId) {
    return (
      <span className={cn(CHIP_CLASS, className)} data-testid="handoff-assignee-chip" data-kind="user">
        <span className="sr-only">{t("localizationActivityChrome.userPrefix")}</span>
        <User className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="max-w-(--sz-12rem) truncate">{userLabel(assignee.userId, resolvers)}</span>
      </span>
    );
  }
  return (
    <span
      className={cn("text-xs italic text-muted-foreground", className)}
      data-testid="handoff-assignee-chip"
      data-kind="unassigned"
    >
      <span className="sr-only">{t("localizationActivityChrome.noResponsiblePrefix")}</span>
      {t("localizationActivityChrome.unassigned")}
    </span>
  );
}

/** The "Wake" sub-row that makes each handoff state self-describing: a queued
 * agent wake, a board-user handoff with no wake, or no agent selected. */
export function HandoffWakeRow({
  to,
  resolvers,
  interruptedRunAttached = false,
}: {
  to: TimelineAssigneeLike;
  resolvers: HandoffChipResolvers;
  interruptedRunAttached?: boolean;
}) {
  const { t } = useTranslation();
  const info = classifyAssigneeHandoff(to, {
    agentName: to.agentId ? agentName(to.agentId, resolvers) : null,
    interruptedRunAttached,
  });
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-xs"
      data-testid="handoff-wake-row"
      data-kind={info.kind}
    >
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("localizationActivityChrome.wakeHeading")}</span>
      <span className={cn(info.kind === "agent_wake" ? "text-foreground" : "text-muted-foreground")}>
        {info.kind === "agent_wake" && to.agentId
          ? t(interruptedRunAttached ? "localizationActivityChrome.queuedForAttached" : "localizationActivityChrome.queuedFor", { name: agentName(to.agentId, resolvers) })
          : info.kind === "user_handoff"
            ? t("localizationActivityChrome.noWakeUser")
            : t("localizationActivityChrome.noWakeUnassigned")}
      </span>
    </div>
  );
}

/** Run status text that distinguishes an intentional operator interrupt
 * (amber "interrupted") from a generic muted "cancelled". */
export function RunStatusBadge({
  status,
  operatorInterrupted = false,
  className,
}: {
  status: string;
  operatorInterrupted?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const p = resolveRunStatusPresentation(status, { operatorInterrupted });
  const statusKeys: Record<string, string> = {"succeeded":"localizationActivityChrome.runStatus_succeeded","failed":"localizationActivityChrome.runStatus_failed","error":"localizationActivityChrome.runStatus_error","timed_out":"localizationActivityChrome.runStatus_timed_out","running":"localizationActivityChrome.runStatus_running","queued":"localizationActivityChrome.runStatus_queued","pending":"localizationActivityChrome.runStatus_pending","cancelled":"localizationActivityChrome.runStatus_cancelled"};
  const label = status === "cancelled" && operatorInterrupted
    ? t("localizationActivityChrome.interrupted")
    : statusKeys[status] ? t(statusKeys[status]) : p.label;
  return (
    <span
      className={cn("font-medium", p.className, className)}
      data-testid="run-status-badge"
      data-interrupted={operatorInterrupted ? "true" : "false"}
    >
      {label}
      {p.srHint ? <span className="sr-only"> — {t("localizationActivityChrome.interruptedByComment")}</span> : null}
    </span>
  );
}

function PreviewChip({
  chip,
  resolvers,
}: {
  chip: NonNullable<ComposerHandoffPreview["chip"]>;
  resolvers: HandoffChipResolvers;
}) {
  return (
    <AssigneeChip
      assignee={chip.kind === "agent" ? { agentId: chip.id, userId: null } : { agentId: null, userId: chip.id }}
      resolvers={resolvers}
    />
  );
}

/** One-line interpretation of what submitting the comment will durably do. */
export function ComposerHandoffPreviewRow({
  preview,
  resolvers,
}: {
  preview: ComposerHandoffPreview;
  resolvers: HandoffChipResolvers;
}) {
  const { t } = useTranslation();
  if (preview.kind === "none") return null;
  const knownPreviews = [{"kind":"interrupt_handoff_agent","text":"Interrupt current run, hand off to","key":"localizationActivityChrome.interruptPreview"},{"kind":"wake_agent","text":"Wake","key":"localizationActivityChrome.wakePreview"},{"kind":"user_handoff","text":"Hand off to","suffix":"— no agent will be notified","key":"localizationActivityChrome.userPreview"},{"kind":"clear_assignee","text":"Clear responsible — no agent will be notified","key":"localizationActivityChrome.clearPreview"},{"kind":"plain_text_only","text":"No agent will be notified. Use @ to mention an agent.","key":"localizationActivityChrome.plainPreview"}];
  const knownPreview = knownPreviews.find((entry) => entry.kind === preview.kind && entry.text === preview.text && entry.suffix === preview.suffix);
  const previewKey = knownPreview?.key ?? (preview.kind === "notify_agent" && preview.text === "Notify"
    ? preview.chip && !preview.suffix ? "localizationActivityChrome.notifyPreview"
      : !preview.chip && preview.suffix === "the mentioned agent" ? "localizationActivityChrome.notifyMentionedPreview" : null
    : null);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-1.5 text-xs",
        preview.tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
      )}
      data-testid="composer-handoff-preview"
      data-kind={preview.kind}
      role="status"
      aria-live="polite"
    >
      {previewKey ? (
        <Trans t={t} i18nKey={previewKey} components={{ target: preview.chip ? <PreviewChip chip={preview.chip} resolvers={resolvers} /> : <span /> }} />
      ) : (
        <>
          <span>{preview.text}</span>
          {preview.chip ? <PreviewChip chip={preview.chip} resolvers={resolvers} /> : null}
          {preview.suffix ? <span>{preview.suffix}</span> : null}
        </>
      )}
    </div>
  );
}

/** Inline coach shown when the body contains a plain agent name without a chip,
 * offering a one-click upgrade to a real mention. */
export function ComposerMentionCoach({
  candidate,
  agentDisplayName,
  onInsert,
  onDismiss,
}: {
  candidate: PlainAgentNameCandidate;
  agentDisplayName: string;
  onInsert: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-amber-300/40 bg-amber-50/70 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
      data-testid="composer-mention-coach"
      role="alert"
      aria-live="polite"
    >
      <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <Trans t={t} i18nKey="localizationActivityChrome.mentionCoach" values={{ name: candidate.matchedText }} components={{ mention: <span className="font-medium" /> }} />
      </span>
      <button
        type="button"
        onClick={onInsert}
        className="shrink-0 rounded border border-amber-400/50 px-1.5 py-0.5 font-medium hover:bg-amber-100/60 dark:hover:bg-amber-500/20"
        aria-label={t("localizationActivityChrome.insertMentionAria", { name: agentDisplayName })}
      >
        {t("localizationActivityChrome.insertMention")}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 hover:bg-amber-100/60 dark:hover:bg-amber-500/20"
        aria-label={t("localizationActivityChrome.dismissSuggestion")}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** Live banner shown at the top of the responsible picker while a run is in flight,
 * warning that reassigning will interrupt it. (design surface 2) */
export function AssigneeRunningBanner({
  copy,
  className,
}: {
  copy: ReassignInterruptCopy;
  className?: string;
}) {
  useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="assignee-running-banner"
      className={cn(
        "flex items-start gap-1.5 rounded-md border border-amber-300/40 bg-amber-50/70 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{interruptBannerText(copy.banner)}</span>
    </div>
  );
}

/** "Interrupt & assign" confirm step shown when an operator picks a different
 * target while a run is live. (design surface 2) */
export function InterruptAssignConfirm({
  copy,
  to,
  resolvers,
  onConfirm,
  onCancel,
}: {
  copy: ReassignInterruptCopy;
  /** The target the operator selected. */
  to: TimelineAssigneeLike;
  resolvers: HandoffChipResolvers;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="interrupt-assign-confirm"
      className="space-y-2 rounded-md border border-amber-300/40 bg-amber-50/70 p-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{handoffText(copy.confirmTitle)}</p>
          <p className="flex flex-wrap items-center gap-1 text-amber-700/90 dark:text-amber-300/90">
            <span>{t("localizationActivityChrome.handOffTo")}</span>
            <AssigneeChip assignee={to} resolvers={resolvers} />
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-amber-400/50 px-2 py-0.5 font-medium hover:bg-amber-100/60 dark:hover:bg-amber-500/20"
        >
          {handoffText(copy.cancelAction)}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          data-testid="interrupt-assign-confirm-action"
          className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400"
        >
          {handoffText(copy.confirmAction)}
        </button>
      </div>
    </div>
  );
}

/** "What this affects" bucket summary for the pause/hold dialog. (design surface 4) */
export function PauseAffectsSummaryView({
  summary,
  className,
}: {
  summary: PauseAffectsSummary;
  className?: string;
}) {
  const { t } = useTranslation();
  const visibleBuckets = summary.buckets.filter((bucket) => bucket.count > 0);
  return (
    <div
      data-testid="pause-affects-summary"
      className={cn("space-y-2 rounded-md border border-border bg-muted/30 p-3", className)}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <PauseCircle className="h-3.5 w-3.5" aria-hidden />
        {t("localizationActivityChrome.whatAffected")}
      </div>
      {summary.nothingLive ? (
        <p role="status" className="text-xs text-muted-foreground" data-testid="pause-nothing-live">
          {t("localizationActivityChrome.nothingLiveToPause")}
        </p>
      ) : null}
      {visibleBuckets.length > 0 ? (
        <ul className="space-y-1">
          {visibleBuckets.map((bucket) => (
            <li
              key={bucket.key}
              data-bucket={bucket.key}
              className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs"
            >
              <span className="font-medium text-foreground">{handoffText(bucket.label)}:</span>
              <span className="tabular-nums text-foreground">{bucket.count}</span>
              <span className="text-muted-foreground">— {handoffText(bucket.detail)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("localizationActivityChrome.noTasksAffected")}</p>
      )}
    </div>
  );
}
