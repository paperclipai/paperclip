import { t, i18n, useTranslation } from "@/i18n";
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
  formatMonitorEtaDisplay,
  formatMonitorAbsoluteDisplay,
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
): MonitorSurfaceCopy | null {
  if (!isWaitingMonitorState(derived.state) || !derived.nextCheckAt) return null;

  if (derived.source === "monitor" && areAutomaticMonitorChecksPaused({ status: issueStatus })) {
    const canCheckNow = canCheckIssueMonitorNow({ status: issueStatus }, derived.serviceName);
    const hint = canCheckNow
      ? "This task is blocked. You can ask the agent to check now."
      : "Resume this task to continue checking.";
    return {
      bannerTitle: "Automatic checks paused",
      stripTitle: "Automatic checks paused",
      bannerMeta: [hint],
      stripMeta: [hint],
      tone: "info",
      automaticChecksPaused: true,
      checkUnavailable: !canCheckNow,
    };
  }

  if (derived.source === "scheduled-retry" && scheduledRetryReason === "workspace_busy") {
    return {
      bannerTitle: t("sep14Runtime.waitingForWorkspace"),
      stripTitle: t("sep14Runtime.waitingForWorkspace"),
      bannerMeta: [t("sep14Runtime.workspaceBusy")],
      stripMeta: [t("sep14Runtime.workspaceAvailable")],
      tone: "info",
      workspaceWait: true,
    };
  }

  const eta = formatMonitorEta(derived.nextCheckAt, now); // "in 2h 12m" | "due now" | "overdue by 18m"
  const absolute = formatMonitorAbsolute(derived.nextCheckAt, {}, now); // local time, e.g. "Today, 4:08 PM"
  if (derived.source === "monitor" && derived.serviceName?.toLowerCase() === "github" && pendingPullRequestReviews > 0) {
    return {
      bannerTitle: "Pull request review requested",
      stripTitle: "Pull request review requested",
      bannerMeta: [`Next check ${eta} · ${absolute} (your time)`],
      stripMeta: [`Next check ${eta} · ${absolute}`],
      tone: derived.state === "overdue" ? "warning" : "info",
      pullRequestReview: true,
    };
  }
  if (derived.source === "scheduled-retry" && scheduledRetryReason === "ai_connection_pool_wait") {
    return {
      bannerTitle: t("oct6Beta.copy009"),
      stripTitle: t("oct6Beta.copy009"),
      bannerMeta: [`Usage recheck ${eta} · ${absolute} (your time)`, t("oct6Beta.copy010")],
      stripMeta: [`Usage recheck ${eta} · ${absolute}`, t("oct6Beta.copy011")],
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
      bannerTitle = isScheduledRetryOnly ? t("localizationIssueChrome.monitorAgentDue") : t("localizationIssueChrome.monitorWaitDue");
      stripTitle = t("localizationIssueChrome.monitorDue");
      statusHint = t("localizationIssueChrome.monitorMomentarily");
      break;
    case "overdue":
    default:
      bannerTitle = isScheduledRetryOnly ? `Agent retry ${eta}` : `Waiting on monitor — ${eta}`;
      stripTitle = capitalize(eta);
      statusHint = t("localizationIssueChrome.monitorNextTick");
      break;
  }

  const attemptLabel = derived.attemptCount >= 1 ? `Attempt ${derived.attemptCount}` : null;
  const serviceLabel = derived.serviceName ? `Watching: ${derived.serviceName}` : null;

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

/** Display projection only; the raw builder remains stable for callers and tests. */
export function buildMonitorSurfaceCopyDisplay(derived: DerivedMonitorState, now: MonitorDate, scheduledRetryReason?: string | null, pendingPullRequestReviews = 0, issueStatus?: string): MonitorSurfaceCopy | null {
  const raw = buildMonitorSurfaceCopy(derived, now, scheduledRetryReason, pendingPullRequestReviews, issueStatus);
  if (!raw || !derived.nextCheckAt || i18n.resolvedLanguage === "en") return raw;
  if (raw.automaticChecksPaused) {
    const hint = raw.checkUnavailable
      ? t("nov02Components.resumeChecksSentence", { defaultValue: "Resume this task to continue checking." })
      : t("nov02Components.blockedManualCheck", { defaultValue: "This task is blocked. You can ask the agent to check now." });
    return { ...raw, bannerTitle: t("nov02Components.automaticChecksPaused", { defaultValue: "Automatic checks paused" }), stripTitle: t("nov02Components.automaticChecksPaused", { defaultValue: "Automatic checks paused" }), bannerMeta: [hint], stripMeta: [hint] };
  }
  if (raw.workspaceWait) {
    return {
      ...raw,
      bannerTitle: t("sep14Runtime.waitingForWorkspace"),
      stripTitle: t("sep14Runtime.waitingForWorkspace"),
      bannerMeta: [t("sep14Runtime.workspaceBusy")],
      stripMeta: [t("sep14Runtime.workspaceAvailable")],
    };
  }
  const eta = formatMonitorEtaDisplay(derived.nextCheckAt, now);
  const absolute = formatMonitorAbsoluteDisplay(derived.nextCheckAt, {}, now);
  if (raw.pullRequestReview) {
    return { ...raw, bannerTitle: t("oct19Tasks.reviewRequested"), stripTitle: t("oct19Tasks.reviewRequested"), bannerMeta: [t("oct19Tasks.nextCheckLocal", { eta, time: absolute })], stripMeta: [t("oct19Tasks.nextCheck", { eta, time: absolute })] };
  }
  if (derived.source === "scheduled-retry" && scheduledRetryReason === "ai_connection_pool_wait") {
    return { ...raw, bannerTitle: t("oct6Beta.copy009"), stripTitle: t("oct6Beta.copy009"), bannerMeta: [t("oct6Beta.poolRecheckLocal", { eta, time: absolute }), t("oct6Beta.copy010")], stripMeta: [t("oct6Beta.poolRecheck", { eta, time: absolute }), t("oct6Beta.copy011")] };
  }
  const retryOnly = derived.source === "scheduled-retry";
  let bannerTitle: string;
  let stripTitle: string;
  let statusHint: string | null = null;
  switch (derived.state) {
    case "scheduled":
    case "retrying":
      bannerTitle = t(retryOnly ? "localizationIssueChrome.monitorAgentResumes" : "localizationIssueChrome.monitorWaitResumes", { eta });
      stripTitle = t("localizationIssueChrome.monitorResumes", { eta });
      break;
    case "due-now":
      bannerTitle = t(retryOnly ? "localizationIssueChrome.monitorAgentDue" : "localizationIssueChrome.monitorWaitDue");
      stripTitle = t("localizationIssueChrome.monitorDue");
      statusHint = t("localizationIssueChrome.monitorMomentarily");
      break;
    default:
      bannerTitle = t(retryOnly ? "localizationIssueChrome.monitorAgentOverdue" : "localizationIssueChrome.monitorWaitOverdue", { eta });
      stripTitle = capitalize(eta);
      statusHint = t("localizationIssueChrome.monitorNextTick");
  }
  const attempt = derived.attemptCount >= 1 ? t("localizationIssueChrome.monitorAttempt", { attempt: derived.attemptCount }) : null;
  const service = derived.serviceName ? t("localizationIssueChrome.monitorService", { service: derived.serviceName }) : null;
  return {
    ...raw,
    bannerTitle,
    stripTitle,
    bannerMeta: [statusHint, t("localizationIssueChrome.monitorLocalTime", { time: absolute }), attempt, service].filter((value): value is string => Boolean(value)),
    stripMeta: [statusHint, absolute, attempt, service].filter((value): value is string => Boolean(value)),
  };
}

function useMonitorSurfaceCopy(issue: Issue, pendingPullRequestReviews: number): MonitorSurfaceCopy | null {
  const { t } = useTranslation();
  // `nextCheckAt` is stable for a given issue; derive once to seed the ticking
  // countdown cadence, then re-derive against the live clock so the surfaces
  // roll scheduled → due → overdue on their own.
  const nextCheckAt = useMemo(() => {
    const derived = deriveMonitorState(issue);
    return derived.source === "monitor" && areAutomaticMonitorChecksPaused(issue) ? null : derived.nextCheckAt;
  }, [issue]);
  const now = useMonitorCountdown(nextCheckAt);
  return useMemo(() => buildMonitorSurfaceCopyDisplay(deriveMonitorState(issue, now), now, issue.scheduledRetry?.scheduledRetryReason, pendingPullRequestReviews, issue.status), [issue, now, pendingPullRequestReviews, t]);
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
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 shadow-none"
      onClick={onCheckNow}
      disabled={checkingNow}
    >
      {checkingNow ? t("localizationIssueChrome.checking") : reviewRequested ? t("oct19Tasks.checkStatus") : t("localizationIssueChrome.checkNow")}
    </Button>
  );
}

function CancelMonitorButton({ onCancel }: { onCancel: () => Promise<unknown> }) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setPending(true);
    setError(null);
    try {
      await onCancel();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("oct19Tasks.cancelMonitorFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); setError(null); } }}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="absolute right-2 top-2" aria-label={t("oct19Tasks.cancelMonitor")} title={t("oct19Tasks.cancelMonitor")}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("oct19Tasks.cancelMonitorTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("oct19Tasks.cancelMonitorConsequence")}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("oct19Tasks.keepMonitor")}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={pending} onClick={() => void cancel()}>{pending ? t("oct19Tasks.cancelling") : t("oct19Tasks.cancelMonitor")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface IssueMonitorSurfaceProps {
  issue: Issue;
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
  onCheckNow = null,
  checkingNow = false,
  workProducts,
  checkError,
  onCancelMonitor,
}: IssueMonitorSurfaceProps) {
  useTranslation();
  const reviews = getIssuePullRequests(workProducts).filter(pullRequestNeedsReview);
  const copy = useMonitorSurfaceCopy(issue, reviews.length);
  if (!copy) return null;

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
  onCheckNow = null,
  checkingNow = false,
  workProducts,
  checkError,
  className,
}: IssueMonitorSurfaceProps & { className?: string }) {
  const { t } = useTranslation();
  const reviews = getIssuePullRequests(workProducts).filter(pullRequestNeedsReview);
  const copy = useMonitorSurfaceCopy(issue, reviews.length);
  if (!copy) return null;

  return (
    <div
      role="note"
      data-testid="issue-monitor-composer-strip"
      className={cn("rounded-lg border border-border bg-muted/30 px-3 py-2", className)}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
        {copy.pullRequestReview
          ? t("oct19Tasks.reviewPullRequestHint")
          : copy.workspaceWait
          ? t("sep14Runtime.keepSendingInstructions")
          : t("localizationIssueChrome.replyWakesAgent")}
      </p>
      ) : null}
      {checkError ? <p role="alert" className="text-sm text-destructive">{checkError}</p> : null}
    </div>
  );
}
