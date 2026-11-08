import { localizeUiError, describeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation, i18n } from "@/i18n";
import { useMemo, useState } from "react";
import { Clock, X } from "lucide-react";
import type { Issue, IssueWorkProduct } from "@paperclipai/shared";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { InlineBanner } from "@/components/InlineBanner";
import { IssuePullRequestLinks } from "@/components/IssuePullRequestLinks";
import { getIssuePullRequests, pullRequestNeedsReview } from "@/lib/issue-pull-requests";
import { cn } from "@/lib/utils";
import {
  areAutomaticMonitorChecksPaused,
  canCheckIssueMonitorNow,
  deriveMonitorState,
  formatMonitorAbsolute,
  formatMonitorEta,
  useMonitorCountdown,
  type DerivedMonitorState,
  type MonitorDisplayState,
} from "@/lib/issue-monitor";

/** Matches the `Date | string` inputs accepted by the issue-monitor helpers. */
type MonitorDate = Date | string;

/**
 * States in which the waiting-monitor surfaces (top banner + composer strip)
 * are shown. `cleared` and `none` hide both surfaces entirely — see
 * wireframe 04 (PAP-14557).
 */
const WAITING_STATES: readonly MonitorDisplayState[] = [
  "scheduled",
  "retrying",
  "due-now",
  "overdue",
];

export function isWaitingMonitorState(state: MonitorDisplayState): boolean {
  return WAITING_STATES.includes(state);
}

export function hasVisibleMonitorSurface(issue: Issue): boolean {
  const derived = deriveMonitorState(issue);
  return isWaitingMonitorState(derived.state) && derived.nextCheckAt !== null;
}

export interface MonitorSurfaceCopy {
  /** Prominent lead for the top banner, e.g. "Waiting on monitor — resumes in 2h 12m". */
  bannerTitle: string;
  /** Prominent lead for the composer strip, e.g. "Resumes in 2h 12m". */
  stripTitle: string;
  /** Muted detail line for the banner (absolute time carries a "(your time)" hint). */
  bannerMeta: string[];
  /** Muted detail line for the composer strip. */
  stripMeta: string[];
  /** `warning` (amber) once overdue, `info` (blue) while still on schedule. */
  tone: "info" | "warning";
  workspaceWait?: boolean;
  pullRequestReview?: boolean;
  automaticChecksPaused?: boolean;
  checkUnavailable?: boolean;
  executionWait?: boolean;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Pure copy builder shared by the banner and the composer strip so both
 * surfaces render one consistent copy system (see wireframe 04). Kept free of
 * hooks/`Date.now()` so it is deterministic under test.
 */
export function buildMonitorSurfaceCopy(
  derived: DerivedMonitorState,
  now: MonitorDate,
  scheduledRetryReason?: string | null,
  pendingPullRequestReviews = 0,
  issueStatus?: string,
  hasActiveRun = false,
): MonitorSurfaceCopy | null {
  if (!isWaitingMonitorState(derived.state) || !derived.nextCheckAt) return null;

  if (derived.source === "monitor" && areAutomaticMonitorChecksPaused({ status: issueStatus })) {
    const canCheckNow = canCheckIssueMonitorNow({ status: issueStatus }, derived.serviceName);
    const hint = canCheckNow
      ? t("final-components-b:IssueMonitorBanner.This_task_is_blocked_You_can_ask_the_agent_to_check_now_fb17fe")
      : t("final-components-b:IssueMonitorBanner.Resume_this_task_to_continue_checking_9d9a6e");
    return {
      get bannerTitle() { return t("final-components-b:IssueMonitorBanner.Automatic_checks_paused_03d978"); },
      get stripTitle() { return t("final-components-b:IssueMonitorBanner.Automatic_checks_paused_03d978"); },
      bannerMeta: [hint],
      stripMeta: [hint],
      tone: "info",
      automaticChecksPaused: true,
      checkUnavailable: !canCheckNow,
    };
  }

  if (derived.source === "scheduled-retry" && scheduledRetryReason === "workspace_busy") {
    return {
      get bannerTitle() { return t("final-components-b:IssueMonitorBanner.Waiting_for_workspace_e682cb"); },
      get stripTitle() { return t("final-components-b:IssueMonitorBanner.Waiting_for_workspace_e682cb"); },
      bannerMeta: [t("final-components-b:IssueMonitorBanner.Another_task_is_using_this_workspace_Work_starts_automatically_wh_db345a")],
      stripMeta: ["Work starts automatically when the workspace is available."],
      tone: "info",
      workspaceWait: true,
    };
  }

  const eta = formatMonitorEta(derived.nextCheckAt, now); // "in 2h 12m" | "due now" | "overdue by 18m"
  const absolute = formatMonitorAbsolute(derived.nextCheckAt, {}, now); // local time, e.g. "Today, 4:08 PM"
  const awaitingPullRequestReview = derived.source === "monitor" && derived.serviceName?.toLowerCase() === "github" && pendingPullRequestReviews > 0;
  if (derived.source === "monitor" && hasActiveRun) {
    const hint = t("task-components:monitorWaitForRunHint");
    return {
      bannerTitle: t("task-components:monitorWaitForRun"),
      stripTitle: t("task-components:monitorWaitForRun"),
      bannerMeta: [hint, t("task-components:monitorScheduledLocal", { absolute })],
      stripMeta: [hint, t("task-components:monitorScheduled", { absolute })],
      tone: "info",
      executionWait: true,
      checkUnavailable: true,
      pullRequestReview: awaitingPullRequestReview,
    };
  }
  if (awaitingPullRequestReview) {
    return {
      get bannerTitle() { return t("final-components-b:IssueMonitorBanner.Pull_request_review_requested_49c186"); },
      get stripTitle() { return t("final-components-b:IssueMonitorBanner.Pull_request_review_requested_49c186"); },
      bannerMeta: [t("final-components-b:Next_check_eta_absolute_your_time_3aab4b", { eta, absolute })],
      stripMeta: [`Next check ${eta} · ${absolute}`],
      tone: derived.state === "overdue" ? "warning" : "info",
      pullRequestReview: true,
    };
  }
  if (derived.source === "scheduled-retry" && scheduledRetryReason === "ai_connection_pool_wait") {
    return {
      get bannerTitle() { return t("final-components-b:IssueMonitorBanner.Pool_exhausted_32acdd"); },
      get stripTitle() { return t("final-components-b:IssueMonitorBanner.Pool_exhausted_32acdd"); },
      bannerMeta: [t("final-components-b:Usage_recheck_eta_absolute_your_time_45250b", { eta, absolute }), t("final-components-b:IssueMonitorBanner.Tasks_with_a_selected_account_keep_it_while_waiting_Work_resumes__6a6fcd")],
      stripMeta: [`Usage recheck ${eta} · ${absolute}`, "Tasks with a selected account keep it while waiting."],
      tone: "info",
    };
  }

  const isScheduledRetryOnly = derived.source === "scheduled-retry";

  let bannerTitle: string;
  let stripTitle: string;
  let statusHint: string | null = null;
  switch (derived.state) {
    case "scheduled":
    case "retrying":
      bannerTitle = isScheduledRetryOnly ? `Agent resumes ${eta}` : `Waiting on monitor — resumes ${eta}`;
      stripTitle = `Resumes ${eta}`;
      break;
    case "due-now":
      bannerTitle = isScheduledRetryOnly ? "Agent retry due now" : "Waiting on monitor — due now";
      stripTitle = "Due now";
      statusHint = "Checking momentarily…";
      break;
    case "overdue":
    default:
      bannerTitle = isScheduledRetryOnly ? `Agent retry ${eta}` : `Waiting on monitor — ${eta}`;
      stripTitle = capitalize(eta);
      statusHint = "Fires on next tick";
      break;
  }

  const attemptLabel = derived.attemptCount >= 1 ? t("task-components:attempt_7a5e6708", { value1: derived.attemptCount }) : null;
  const serviceLabel = derived.serviceName ? t("final-components-b:Watching_serviceName_7d831f", { serviceName: derived.serviceName }) : null;

  const bannerMeta = [statusHint, `${absolute} (your time)`, attemptLabel, serviceLabel].filter(
    (piece): piece is string => Boolean(piece),
  );
  const stripMeta = [statusHint, absolute, attemptLabel, serviceLabel].filter(
    (piece): piece is string => Boolean(piece),
  );

  return {
    bannerTitle,
    stripTitle,
    bannerMeta,
    stripMeta,
    tone: derived.state === "overdue" ? "warning" : "info",
  };
}

function useMonitorSurfaceCopy(issue: Issue, pendingPullRequestReviews: number, hasActiveRun: boolean): MonitorSurfaceCopy | null {
  // `nextCheckAt` is stable for a given issue; derive once to seed the ticking
  // countdown cadence, then re-derive against the live clock so the surfaces
  // roll scheduled → due → overdue on their own.
  const nextCheckAt = useMemo(() => {
    const derived = deriveMonitorState(issue);
    return derived.source === "monitor" && areAutomaticMonitorChecksPaused(issue) ? null : derived.nextCheckAt;
  }, [issue]);
  const now = useMonitorCountdown(nextCheckAt);
  return useMemo(() => buildMonitorSurfaceCopy(deriveMonitorState(issue, now), now, issue.scheduledRetry?.scheduledRetryReason, pendingPullRequestReviews, issue.status, hasActiveRun), [issue, now, pendingPullRequestReviews, hasActiveRun, i18n.resolvedLanguage]);
}

function CheckNowButton({
  onCheckNow,
  checkingNow,
  reviewRequested = false,
}: {
  onCheckNow: () => void;
  checkingNow: boolean;
  reviewRequested?: boolean;
}) {
  useTranslation("task-components");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 shadow-none"
      onClick={onCheckNow}
      disabled={checkingNow}
    >
      {checkingNow ? t("task-components:checking_ec963ffc") : reviewRequested ? t("task-components:checkStatus_69cd3590") : t("task-components:checkNow_2937cffb")}
    </Button>
  );
}

function CancelMonitorButton({ onCancel }: { onCancel: () => Promise<unknown> }) {
  useTranslation("task-components");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cancel = async () => {
    setPending(true);
    setError(null);
    try {
      await onCancel();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err : localizeUiError(new Error("Unable to cancel the monitor. Try again."), { key: "final-components-b:error.Unable_to_cancel_the_monitor_Try_again_c98815" }));
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); setError(null); } }}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="absolute right-2 top-2" aria-label={t("task-components:cancelMonitor_725cf6ee")} title={t("task-components:cancelMonitor_725cf6ee")}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("task-components:cancelMonitor_ed370fae")}</AlertDialogTitle>
          <AlertDialogDescription>{t("task-components:thisRemovesTheScheduledMonitorCheckThe_4317d6f1")}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{describeUiError(error).body}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("task-components:keepMonitor_a498617d")}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={pending} onClick={() => void cancel()}>{pending ? t("task-components:cancelling_91b104db") : t("task-components:cancelMonitor_725cf6ee")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface IssueMonitorSurfaceProps {
  issue: Issue;
  hasActiveRun?: boolean;
  onCheckNow?: (() => void) | null;
  checkingNow?: boolean;
  workProducts?: IssueWorkProduct[] | null;
  checkError?: string | null;
  onCancelMonitor?: (() => Promise<unknown>) | null;
}

/**
 * Pinned banner rendered between the issue title and description while a
 * monitor is waiting. Replaces the description-area "Monitor scheduled" card
 * for the waiting state (PAP-14557 decision 1) — the two never render at once.
 */
export function IssueMonitorBanner({
  issue,
  hasActiveRun = false,
  onCheckNow = null,
  checkingNow = false,
  workProducts,
  checkError,
  onCancelMonitor,
}: IssueMonitorSurfaceProps) {
  useTranslation("task-components");
  const reviews = getIssuePullRequests(workProducts).filter(pullRequestNeedsReview);
  const copy = useMonitorSurfaceCopy(issue, reviews.length, hasActiveRun);
  if (!copy) return null;

  // A busy workspace is a transient system wait the user cannot act on. It stays
  // a quiet status (composer strip, properties row), never a pinned notice.
  if (copy.workspaceWait) return null;

  const canCancel = onCancelMonitor && deriveMonitorState(issue).source === "monitor";

  return (
    <InlineBanner
      tone={copy.tone}
      icon={Clock}
      title={copy.bannerTitle}
      className={cn("relative my-3", canCancel && "pr-12")}
      actions={onCheckNow && !copy.workspaceWait && !copy.checkUnavailable ? <CheckNowButton onCheckNow={onCheckNow} checkingNow={checkingNow} reviewRequested={copy.pullRequestReview} /> : null}
    >
      {canCancel ? <CancelMonitorButton key={issue.id} onCancel={onCancelMonitor} /> : null}
      <div className="flex flex-col gap-2">
        {copy.pullRequestReview ? <IssuePullRequestLinks products={reviews} /> : null}
        <span>{copy.bannerMeta.join("  ·  ")}</span>
        {checkError ? <p role="alert">{checkError}</p> : null}
      </div>
    </InlineBanner>
  );
}

/**
 * Slim, inline (not sticky) strip anchored directly above the reply composer.
 * Mirrors the banner's monitor state and reminds the reader that replying wakes
 * the agent early (PAP-14557 decisions 2 + wireframe 02).
 */
export function IssueMonitorComposerStrip({
  issue,
  hasActiveRun = false,
  onCheckNow = null,
  checkingNow = false,
  workProducts,
  checkError,
  className,
}: IssueMonitorSurfaceProps & { className?: string }) {
  useTranslation("task-components");
  const reviews = getIssuePullRequests(workProducts).filter(pullRequestNeedsReview);
  const copy = useMonitorSurfaceCopy(issue, reviews.length, hasActiveRun);
  if (!copy) return null;

  return (
    <div
      role="note"
      data-testid="issue-monitor-composer-strip"
      className={cn("rounded-lg border border-border bg-muted/30 px-3 py-2", className)}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Clock className={cn("mt-0.5 h-4 w-4 shrink-0", issue.displayStatus === "monitoring" ? "text-(--status-task-icon-monitoring)" : "text-muted-foreground")} aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-2">
            <div className="text-sm font-medium text-foreground">{copy.stripTitle}</div>
            {copy.pullRequestReview ? <IssuePullRequestLinks products={reviews} /> : null}
            <div className="text-xs text-muted-foreground">{copy.stripMeta.join(" · ")}</div>
          </div>
        </div>
        {onCheckNow && !copy.workspaceWait && !copy.checkUnavailable ? <CheckNowButton onCheckNow={onCheckNow} checkingNow={checkingNow} reviewRequested={copy.pullRequestReview} /> : null}
      </div>
      {!copy.automaticChecksPaused ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {copy.pullRequestReview && copy.executionWait
            ? t("task-components:monitorReviewDuringRun")
            : copy.pullRequestReview
            ? t("task-components:reviewOnGithubThenCheckStatusTo_138c837a")
            : copy.workspaceWait || copy.executionWait
            ? t("task-components:youCanKeepSendingInstructionsWhileThe_863825ba")
            : t("task-components:sendingAReplyWakesTheAgentNow_c39c874e")}
        </p>
      ) : null}
      {checkError ? <p role="alert" className="text-sm text-destructive">{checkError}</p> : null}
    </div>
  );
}
