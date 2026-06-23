import type {
  IssueBlockerAttention,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, Flag, Loader2, RotateCcw } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { formatMonitorOffset } from "../lib/issue-monitor";
import { useRetryNowMutation } from "../hooks/useRetryNowMutation";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";
import { RetryErrorBand } from "./IssueScheduledRetryCard";
import { isAssignedBacklogBlocker } from "../lib/issue-blockers";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
  recoveryChipLabel,
} from "../lib/recovery-display";

function BlockerRecoveryIndicator({ action }: { action: IssueRecoveryAction }) {
  const { t } = useTranslation();
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  const label = recoveryChipLabel(state, action.kind);
  return (
    <span
      data-testid="issue-blocked-notice-recovery-indicator"
      data-recovery-state={state}
      data-recovery-kind={action.kind}
      role="status"
      aria-label={label}
      title={t("components.issueBlockedNotice.recoveryIndicatorTitle", {
        label,
        defaultValue: "{{label}} — open the source task to act.",
      })}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${tone.className}`}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </span>
  );
}

function SuccessfulRunRetryNowControl({
  issueId,
  scheduledRetry,
}: {
  issueId: string;
  scheduledRetry: IssueScheduledRetry;
}) {
  const { t } = useTranslation();
  const retryNow = useRetryNowMutation(issueId);
  const dueAtIso = scheduledRetry.scheduledRetryAt
    ? new Date(scheduledRetry.scheduledRetryAt).toISOString()
    : null;
  const relative = dueAtIso ? formatMonitorOffset(dueAtIso) : null;
  const scheduleLabel = relative === "now"
    ? t("components.issueBlockedNotice.scheduleLabelDueNow", { defaultValue: "due now" })
    : relative
      ? t("components.issueBlockedNotice.scheduleLabelScheduledRelative", {
          relative,
          defaultValue: "scheduled {{relative}}",
        })
      : t("components.issueBlockedNotice.scheduleLabelScheduled", { defaultValue: "scheduled" });
  const success = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");

  return (
    <div className="mt-2 rounded-md border border-amber-300/70 bg-background/80 p-2 dark:border-amber-500/40 dark:bg-background/40">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs leading-5 text-amber-900 dark:text-amber-100">
          {t("components.issueBlockedNotice.correctiveWakeSchedule", {
            scheduleLabel,
            defaultValue:
              "Corrective wake {{scheduleLabel}}. Retry now starts the same recovery path immediately.",
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-amber-300/80 bg-background/80 text-amber-950 shadow-none hover:bg-amber-100 dark:border-amber-500/50 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
          onClick={() => retryNow.mutate()}
          disabled={retryNow.isPending || success}
          data-testid="issue-next-step-retry-now"
        >
          {retryNow.isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t("components.issueBlockedNotice.retrying", { defaultValue: "Retrying..." })}
            </span>
          ) : success ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {retryNow.data?.outcome === "already_promoted"
                ? t("components.issueBlockedNotice.alreadyPromoted", {
                    defaultValue: "Already promoted",
                  })
                : t("components.issueBlockedNotice.promoted", { defaultValue: "Promoted" })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t("components.issueBlockedNotice.retryNow", { defaultValue: "Retry now" })}
            </span>
          )}
        </Button>
      </div>
      <RetryErrorBand
        error={retryNow.lastError}
        className="mt-2 border-amber-300/70 bg-amber-100/70 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100"
        onRetry={() => {
          retryNow.reset();
          retryNow.mutate();
        }}
      />
    </div>
  );
}

export function IssueBlockedNotice({
  issueId,
  issueStatus,
  blockers,
  blockerAttention,
  successfulRunHandoff,
  scheduledRetry,
  agentName,
}: {
  issueId?: string | null;
  issueStatus?: string;
  blockers: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  agentName?: string | null;
}) {
  const { t } = useTranslation();
  if (issueStatus === "done" || issueStatus === "cancelled") return null;
  const showSuccessfulRunHandoff = successfulRunHandoff?.required === true;
  if (!showSuccessfulRunHandoff && blockers.length === 0 && issueStatus !== "blocked") return null;
  const successfulRunRetryNow = showSuccessfulRunHandoff
    && issueId
    && scheduledRetry?.status === "scheduled_retry"
      ? { issueId, scheduledRetry }
      : null;

  const blockerLabel = blockers.length === 1
    ? t("components.issueBlockedNotice.blockerLabelSingular", { defaultValue: "the linked task" })
    : t("components.issueBlockedNotice.blockerLabelPlural", { defaultValue: "the linked tasks" });
  const terminalBlockers = blockers
    .flatMap((blocker) => blocker.terminalBlockers ?? [])
    .filter((blocker, index, all) => all.findIndex((candidate) => candidate.id === blocker.id) === index);

  const isStalled = blockerAttention?.state === "stalled";
  const parkedBlockers = (() => {
    const seen = new Set<string>();
    const collected: IssueRelationIssueSummary[] = [];
    const sources: IssueRelationIssueSummary[] = [...blockers];
    for (const blocker of blockers) {
      for (const terminal of blocker.terminalBlockers ?? []) {
        sources.push(terminal);
      }
    }
    for (const blocker of sources) {
      if (!isAssignedBacklogBlocker(blocker)) continue;
      if (seen.has(blocker.id)) continue;
      seen.add(blocker.id);
      collected.push(blocker);
    }
    return collected;
  })();
  const showParkedRow = parkedBlockers.length > 0;
  const stalledLeafIdentifier =
    blockerAttention?.sampleStalledBlockerIdentifier ?? blockerAttention?.sampleBlockerIdentifier ?? null;
  const stalledLeafBlockers = (() => {
    const candidates: IssueRelationIssueSummary[] = [];
    for (const blocker of [...blockers, ...terminalBlockers]) {
      if (blocker.status !== "in_review") continue;
      if (candidates.some((existing) => existing.id === blocker.id)) continue;
      candidates.push(blocker);
    }
    if (stalledLeafIdentifier) {
      const preferred = candidates.find(
        (blocker) => (blocker.identifier ?? blocker.id) === stalledLeafIdentifier,
      );
      if (preferred) {
        return [preferred, ...candidates.filter((blocker) => blocker.id !== preferred.id)];
      }
    }
    return candidates;
  })();
  const showStalledRow = isStalled && stalledLeafBlockers.length > 0;

  const renderBlockerChip = (blocker: IssueRelationIssueSummary) => {
    const issuePathId = blocker.identifier ?? blocker.id;
    const recoveryAction = blocker.activeRecoveryAction ?? null;
    return (
      <IssueLinkQuicklook
        key={blocker.id}
        issuePathId={issuePathId}
        to={createIssueDetailPath(issuePathId)}
        className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-xs text-amber-950 transition-colors hover:border-amber-500 hover:bg-amber-100 hover:underline dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
      >
        <span>{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
        <span className="max-w-[18rem] truncate font-sans text-[11px] text-amber-800 dark:text-amber-200">
          {blocker.title}
        </span>
        {recoveryAction ? <BlockerRecoveryIndicator action={recoveryAction} /> : null}
      </IssueLinkQuicklook>
    );
  };

  return (
    <div
      data-blocker-attention-state={blockerAttention?.state}
      data-successful-run-handoff={showSuccessfulRunHandoff ? "required" : undefined}
      className="mb-3 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 space-y-1.5">
          {showSuccessfulRunHandoff ? (
            <>
              <p className="font-medium leading-5">
                {t("components.issueBlockedNotice.needsNextStep", {
                  defaultValue: "This task still needs a next step.",
                })}
              </p>
              <p className="leading-5">
                {t("components.issueBlockedNotice.handoffOpenIntro", {
                  defaultValue: "A run finished successfully, but this task is still open in",
                })}{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 text-[12px] dark:bg-amber-400/15">
                  in_progress
                </code>{" "}
                {t("components.issueBlockedNotice.handoffOpenOutro", {
                  defaultValue: "with no clear owner for the next action.",
                })}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-amber-900 dark:text-amber-100">
                <li>
                  {t("components.issueBlockedNotice.handoffOptionMarkDone", {
                    defaultValue: "Mark it done or cancelled.",
                  })}
                </li>
                <li>
                  {t("components.issueBlockedNotice.handoffOptionSendReview", {
                    defaultValue: "Send it for review or ask for input.",
                  })}
                </li>
                <li>
                  {t("components.issueBlockedNotice.handoffOptionMarkBlocked", {
                    defaultValue: "Mark it blocked with a blocker owner.",
                  })}
                </li>
                <li>
                  {t("components.issueBlockedNotice.handoffOptionDelegate", {
                    defaultValue: "Delegate follow-up work or queue a continuation.",
                  })}
                </li>
              </ul>
              <div className="flex flex-wrap gap-1.5 text-xs">
                {successfulRunHandoff.sourceRunId && successfulRunHandoff.assigneeAgentId ? (
                  <Link
                    to={`/agents/${successfulRunHandoff.assigneeAgentId}/runs/${successfulRunHandoff.sourceRunId}`}
                    className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-amber-950 hover:border-amber-500 hover:bg-amber-100 hover:underline dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
                  >
                    {t("components.issueBlockedNotice.runLabel", {
                      runId: successfulRunHandoff.sourceRunId.slice(0, 8),
                      defaultValue: "run {{runId}}",
                    })}
                  </Link>
                ) : successfulRunHandoff.sourceRunId ? (
                  <span className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 font-mono text-amber-950 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100">
                    {t("components.issueBlockedNotice.runLabel", {
                      runId: successfulRunHandoff.sourceRunId.slice(0, 8),
                      defaultValue: "run {{runId}}",
                    })}
                  </span>
                ) : null}
                <span className="rounded-md border border-amber-300/70 bg-background/80 px-2 py-1 text-amber-900 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100">
                  {t("components.issueBlockedNotice.correctiveWakeQueuedFor", {
                    agentName:
                      agentName
                      ?? t("components.issueBlockedNotice.theAssignee", {
                        defaultValue: "the assignee",
                      }),
                    defaultValue: "Corrective wake queued for {{agentName}}",
                  })}
                </span>
              </div>
              {successfulRunHandoff.detectedProgressSummary ? (
                <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
                  {t("components.issueBlockedNotice.detectedProgress", {
                    summary: successfulRunHandoff.detectedProgressSummary,
                    defaultValue: "Detected progress: {{summary}}",
                  })}
                </p>
              ) : null}
              {successfulRunRetryNow ? (
                <SuccessfulRunRetryNowControl
                  issueId={successfulRunRetryNow.issueId}
                  scheduledRetry={successfulRunRetryNow.scheduledRetry}
                />
              ) : null}
            </>
          ) : null}
          {showSuccessfulRunHandoff && (blockers.length > 0 || issueStatus === "blocked") ? (
            <div className="border-t border-amber-300/60 pt-1.5 dark:border-amber-500/30" />
          ) : null}
          {blockers.length > 0 || issueStatus === "blocked" ? (
            <>
              <p className="leading-5">
                {blockers.length > 0
                  ? isStalled
                    ? stalledLeafBlockers.length > 1
                      ? t("components.issueBlockedNotice.blockedStalledMultiple", {
                          blockerLabel,
                          defaultValue:
                            "Work on this task is blocked by {{blockerLabel}}, but the chain is stalled in review without a clear next step. Resolve the stalled reviews below or remove them as blockers.",
                        })
                      : t("components.issueBlockedNotice.blockedStalledSingle", {
                          blockerLabel,
                          defaultValue:
                            "Work on this task is blocked by {{blockerLabel}}, but the chain is stalled in review without a clear next step. Resolve the stalled review below or remove it as a blocker.",
                        })
                    : t("components.issueBlockedNotice.blockedUntilComplete", {
                        blockerLabel,
                        pronoun:
                          blockers.length === 1
                            ? t("components.issueBlockedNotice.pronounItIs", {
                                defaultValue: "it is",
                              })
                            : t("components.issueBlockedNotice.pronounTheyAre", {
                                defaultValue: "they are",
                              }),
                        defaultValue:
                          "Work on this task is blocked by {{blockerLabel}} until {{pronoun}} complete. Comments still wake the assignee for questions or triage.",
                      })
                  : t("components.issueBlockedNotice.blockedUntilTodo", {
                      defaultValue:
                        "Work on this task is blocked until it is moved back to todo. Comments still wake the assignee for questions or triage.",
                    })}
              </p>
              {blockers.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {blockers.map(renderBlockerChip)}
                </div>
              ) : null}
              {showStalledRow ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    {t("components.issueBlockedNotice.stalledInReview", {
                      defaultValue: "Stalled in review",
                    })}
                  </span>
                  {stalledLeafBlockers.map(renderBlockerChip)}
                </div>
              ) : terminalBlockers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    {t("components.issueBlockedNotice.ultimatelyWaitingOn", {
                      defaultValue: "Ultimately waiting on",
                    })}
                  </span>
                  {terminalBlockers.map(renderBlockerChip)}
                </div>
              ) : null}
              {showParkedRow ? (
                <div
                  data-testid="issue-blocked-notice-parked-row"
                  className="flex flex-wrap items-center gap-1.5 pt-0.5"
                >
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                    <Flag className="h-3 w-3" aria-hidden />
                    {t("components.issueBlockedNotice.blockedByParkedWork", {
                      defaultValue: "Blocked by parked work",
                    })}
                  </span>
                  {parkedBlockers.map(renderBlockerChip)}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
