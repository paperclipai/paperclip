import { useMemo } from "react";
import type {
  Agent,
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";
import { Eye, OctagonAlert, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { t, useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { agentUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  deriveRecoveryDisplayState,
  type RecoveryDisplayState,
} from "@/lib/recovery-display";

export type RecoveryCardCardState = RecoveryDisplayState;
export const deriveRecoveryCardState = deriveRecoveryDisplayState;

export type RecoveryResolveOutcome =
  | "todo"
  | "done"
  | "in_review"
  | "false_positive_done"
  | "false_positive_in_review";

export interface IssueRecoveryActionCardProps {
  action: IssueRecoveryAction;
  agentMap?: ReadonlyMap<string, Agent>;
  /** Preferred state hint (e.g. observe_only when watchdog tone is requested). Falls back to derived state. */
  forcedState?: RecoveryCardCardState;
  /** Optional click handler for resolve menu actions. If omitted, the buttons are not rendered. */
  onResolve?: (outcome: RecoveryResolveOutcome) => void;
  /** Whether the viewer can run destructive board-only actions (e.g. false-positive dismissal). */
  canFalsePositive?: boolean;
  className?: string;
}

function getKindLabel(): Record<IssueRecoveryActionKind, string> {
  return {
    missing_disposition: t("components.issueRecoveryActionCard.kindLabelMissingDisposition", {
      defaultValue: "Missing Disposition",
    }),
    stranded_assigned_issue: t("components.issueRecoveryActionCard.kindLabelStrandedAssignedIssue", {
      defaultValue: "Stranded Task",
    }),
    workspace_validation: t("components.issueRecoveryActionCard.kindLabelWorkspaceValidation", {
      defaultValue: "Workspace Validation",
    }),
    configuration_validation: t("components.issueRecoveryActionCard.kindLabelConfigurationValidation", {
      defaultValue: "Configuration Validation",
    }),
    active_run_watchdog: t("components.issueRecoveryActionCard.kindLabelActiveRunWatchdog", {
      defaultValue: "Active Watchdog",
    }),
    issue_graph_liveness: t("components.issueRecoveryActionCard.kindLabelIssueGraphLiveness", {
      defaultValue: "Graph Liveness",
    }),
  };
}

function getKindHeadline(): Record<IssueRecoveryActionKind, string> {
  return {
    missing_disposition: t("components.issueRecoveryActionCard.kindHeadlineMissingDisposition", {
      defaultValue: "This task's run finished, but no next step was chosen.",
    }),
    stranded_assigned_issue: t("components.issueRecoveryActionCard.kindHeadlineStrandedAssignedIssue", {
      defaultValue:
        "Paperclip retried this task's last run and it still has no live execution path.",
    }),
    workspace_validation: t("components.issueRecoveryActionCard.kindHeadlineWorkspaceValidation", {
      defaultValue:
        "Paperclip stopped this run because the task's git workspace could not be validated.",
    }),
    configuration_validation: t("components.issueRecoveryActionCard.kindHeadlineConfigurationValidation", {
      defaultValue:
        "Paperclip stopped before dispatching this run because required secret/env bindings are missing.",
    }),
    active_run_watchdog: t("components.issueRecoveryActionCard.kindHeadlineActiveRunWatchdog", {
      defaultValue:
        "The active run has been silent. Recovery is observing without interrupting it.",
    }),
    issue_graph_liveness: t("components.issueRecoveryActionCard.kindHeadlineIssueGraphLiveness", {
      defaultValue:
        "Paperclip detected this task lost a live action path. A recovery owner needs to act.",
    }),
  };
}

function getStateLabel(): Record<RecoveryCardCardState, string> {
  return {
    needed: t("components.issueRecoveryActionCard.stateLabelNeeded", {
      defaultValue: "RECOVERY NEEDED",
    }),
    in_progress: t("components.issueRecoveryActionCard.stateLabelInProgress", {
      defaultValue: "RECOVERY IN PROGRESS",
    }),
    observe_only: t("components.issueRecoveryActionCard.stateLabelObserveOnly", {
      defaultValue: "OBSERVING ACTIVE RUN",
    }),
    escalated: t("components.issueRecoveryActionCard.stateLabelEscalated", {
      defaultValue: "RECOVERY ESCALATED",
    }),
    resolved: t("components.issueRecoveryActionCard.stateLabelResolved", {
      defaultValue: "RECOVERY RESOLVED",
    }),
  };
}
const STATE_TONE: Record<RecoveryCardCardState, {
  containerClass: string;
  iconWrapClass: string;
  iconClass: string;
  labelClass: string;
  Icon: typeof TriangleAlert;
  divider: string;
}> = {
  needed: {
    containerClass:
      "border-amber-300/70 bg-amber-50/85 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    iconWrapClass: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    iconClass: "text-amber-700 dark:text-amber-300",
    labelClass: "text-amber-900 dark:text-amber-200",
    Icon: TriangleAlert,
    divider: "border-amber-300/60 dark:border-amber-500/30",
  },
  in_progress: {
    containerClass:
      "border-sky-300/70 bg-sky-50/80 text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
    iconWrapClass: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
    iconClass: "text-sky-700 dark:text-sky-300",
    labelClass: "text-sky-900 dark:text-sky-200",
    Icon: RefreshCw,
    divider: "border-sky-300/60 dark:border-sky-500/30",
  },
  observe_only: {
    containerClass:
      "border-border bg-muted/40 text-foreground dark:bg-muted/20",
    iconWrapClass: "bg-muted text-foreground/70",
    iconClass: "text-muted-foreground",
    labelClass: "text-muted-foreground",
    Icon: Eye,
    divider: "border-border/70",
  },
  escalated: {
    containerClass:
      "border-red-400/60 bg-red-50/85 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    iconWrapClass: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
    iconClass: "text-red-700 dark:text-red-300",
    labelClass: "text-red-900 dark:text-red-200",
    Icon: OctagonAlert,
    divider: "border-red-400/50 dark:border-red-500/30",
  },
  resolved: {
    containerClass:
      "border-emerald-300/70 bg-emerald-50/80 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
    iconWrapClass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    iconClass: "text-emerald-700 dark:text-emerald-300",
    labelClass: "text-emerald-900 dark:text-emerald-200",
    Icon: Sparkles,
    divider: "border-emerald-300/60 dark:border-emerald-500/30",
  },
};

function getOutcomeLabel(): Record<IssueRecoveryActionOutcome, string> {
  return {
    restored: t("components.issueRecoveryActionCard.outcomeRestored", {
      defaultValue: "restored",
    }),
    delegated: t("components.issueRecoveryActionCard.outcomeDelegated", {
      defaultValue: "delegated to follow-up",
    }),
    false_positive: t("components.issueRecoveryActionCard.outcomeFalsePositive", {
      defaultValue: "false positive",
    }),
    blocked: t("components.issueRecoveryActionCard.outcomeBlocked", {
      defaultValue: "blocked",
    }),
    escalated: t("components.issueRecoveryActionCard.outcomeEscalated", {
      defaultValue: "escalated",
    }),
    cancelled: t("components.issueRecoveryActionCard.outcomeCancelled", {
      defaultValue: "cancelled",
    }),
  };
}

function readEvidenceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}

function pickEvidenceSummary(action: IssueRecoveryAction): string | null {
  const evidence = action.evidence ?? {};
  const candidates = [
    "summary",
    "detectedProgressSummary",
    "missingDisposition",
    "retryReason",
    "latestRunErrorCode",
    "latestRunStatus",
    "latestIssueStatus",
  ] as const;
  for (const key of candidates) {
    const next = readEvidenceString(evidence[key]);
    if (next) return next;
  }
  return null;
}

function readEvidenceRunId(action: IssueRecoveryAction, key: "sourceRunId" | "correctiveRunId" | "latestRunId") {
  const evidence = action.evidence ?? {};
  const next = readEvidenceString(evidence[key]);
  return next;
}

function readWakePolicySummary(action: IssueRecoveryAction): string | null {
  const policy = action.wakePolicy;
  if (!policy) return null;
  const type = readEvidenceString(policy.type);
  if (!type) return null;
  if (type === "wake_owner")
    return t("components.issueRecoveryActionCard.wakeCorrectiveQueued", {
      defaultValue: "Corrective wake queued",
    });
  if (type === "board_escalation")
    return t("components.issueRecoveryActionCard.wakeEscalatedToBoard", {
      defaultValue: "Escalated to board",
    });
  if (type === "manual")
    return t("components.issueRecoveryActionCard.wakeManual", { defaultValue: "Manual" });
  if (type === "manual_repair_required")
    return t("components.issueRecoveryActionCard.wakeManualRepairRequired", {
      defaultValue: "Manual repair required",
    });
  if (type === "monitor") {
    const interval = readEvidenceString(policy.intervalLabel);
    return interval
      ? t("components.issueRecoveryActionCard.wakeMonitorScheduledInterval", {
          interval,
          defaultValue: "Monitor scheduled · {{interval}}",
        })
      : t("components.issueRecoveryActionCard.wakeMonitorScheduled", {
          defaultValue: "Monitor scheduled",
        });
  }
  return type.replaceAll("_", " ");
}

function formatTimeShort(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const now = Date.now();
    const diffMs = date.getTime() - now;
    const absMin = Math.round(Math.abs(diffMs) / 60_000);
    if (absMin < 60) {
      return diffMs >= 0
        ? t("components.issueRecoveryActionCard.timeInMinutes", {
            count: absMin,
            defaultValue: "in {{count}}m",
            defaultValue_other: "in {{count}}m",
          })
        : t("components.issueRecoveryActionCard.timeMinutesAgo", {
            count: absMin,
            defaultValue: "{{count}}m ago",
            defaultValue_other: "{{count}}m ago",
          });
    }
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function shortenRunId(runId: string | null | undefined) {
  if (!runId) return null;
  if (runId.length <= 12) return runId;
  return runId.slice(0, 8);
}

function MetadataRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0 px-3 py-1.5 text-xs sm:px-4">
      <dt className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground/90">{children}</dd>
    </div>
  );
}

function MissingValue() {
  return <span className="text-muted-foreground">—</span>;
}

function AgentLink({
  agentId,
  agentMap,
  fallback,
}: {
  agentId: string | null | undefined;
  agentMap?: ReadonlyMap<string, Agent>;
  fallback?: string | null;
}) {
  const { t } = useTranslation();
  if (!agentId) {
    return fallback ? <span>{fallback}</span> : <MissingValue />;
  }
  const agent = agentMap?.get(agentId);
  const label =
    agent?.name ??
    t("components.issueRecoveryActionCard.agentFallback", {
      id: agentId.slice(0, 8),
      defaultValue: "agent {{id}}",
    });
  if (agent) {
    return (
      <Link
        to={agentUrl(agent)}
        className="rounded-sm font-medium underline-offset-2 hover:underline"
      >
        {label}
      </Link>
    );
  }
  return <span className="font-medium">{label}</span>;
}

function RunChip({
  runId,
  agentId,
  status,
}: {
  runId: string | null;
  agentId: string | null | undefined;
  status?: string | null;
}) {
  const { t } = useTranslation();
  if (!runId) return <MissingValue />;
  const short = shortenRunId(runId);
  const inner = (
    <>
      <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
        {t("components.issueRecoveryActionCard.runChip", {
          id: short,
          defaultValue: "run {{id}}",
        })}
      </code>
      {status ? (
        <span className="font-sans text-[11px] text-muted-foreground">{status}</span>
      ) : null}
    </>
  );
  if (agentId) {
    return (
      <Link
        to={`/agents/${agentId}/runs/${runId}`}
        className="inline-flex items-center gap-2 rounded-sm underline-offset-2 hover:underline"
      >
        {inner}
      </Link>
    );
  }
  return <span className="inline-flex items-center gap-2">{inner}</span>;
}

function getResolveOptions(): Array<{
  outcome: RecoveryResolveOutcome;
  label: string;
  description: string;
  destructive?: boolean;
  boardOnly?: boolean;
}> {
  return [
    {
      outcome: "todo",
      label: t("components.issueRecoveryActionCard.resolveTodoLabel", {
        defaultValue: "Try again",
      }),
      description: t("components.issueRecoveryActionCard.resolveTodoDescription", {
        defaultValue: "Dismiss recovery and return the source task to todo.",
      }),
    },
    {
      outcome: "done",
      label: t("components.issueRecoveryActionCard.resolveDoneLabel", {
        defaultValue: "Mark task done",
      }),
      description: t("components.issueRecoveryActionCard.resolveDoneDescription", {
        defaultValue: "Restore by recording the requested work as complete.",
      }),
    },
    {
      outcome: "in_review",
      label: t("components.issueRecoveryActionCard.resolveInReviewLabel", {
        defaultValue: "Send for review",
      }),
      description: t("components.issueRecoveryActionCard.resolveInReviewDescription", {
        defaultValue: "Hand off to a reviewer with a real review path.",
      }),
    },
    {
      outcome: "false_positive_done",
      label: t("components.issueRecoveryActionCard.resolveFalsePositiveDoneLabel", {
        defaultValue: "False positive, done",
      }),
      description: t("components.issueRecoveryActionCard.resolveFalsePositiveDoneDescription", {
        defaultValue: "Dismiss recovery and mark the source task complete.",
      }),
      destructive: true,
      boardOnly: true,
    },
    {
      outcome: "false_positive_in_review",
      label: t("components.issueRecoveryActionCard.resolveFalsePositiveInReviewLabel", {
        defaultValue: "False positive, review",
      }),
      description: t("components.issueRecoveryActionCard.resolveFalsePositiveInReviewDescription", {
        defaultValue: "Dismiss recovery and send the source task for review.",
      }),
      destructive: true,
      boardOnly: true,
    },
  ];
}

export function IssueRecoveryActionCard({
  action,
  agentMap,
  forcedState,
  onResolve,
  canFalsePositive = false,
  className,
}: IssueRecoveryActionCardProps) {
  const { t } = useTranslation();
  const cardState: RecoveryCardCardState = forcedState ?? deriveRecoveryCardState(action);
  const tone = STATE_TONE[cardState];
  const toneLabel = getStateLabel()[cardState];
  const ToneIcon = tone.Icon;

  const headline = useMemo(() => {
    if (cardState === "resolved" && action.outcome) {
      const outcomeLabel = getOutcomeLabel()[action.outcome] ?? action.outcome;
      return t("components.issueRecoveryActionCard.headlineResolvedAs", {
        outcome: outcomeLabel,
        defaultValue: "Recovery resolved as {{outcome}}.",
      });
    }
    const kindHeadline = getKindHeadline();
    return kindHeadline[action.kind] ?? kindHeadline.missing_disposition;
  }, [action.kind, action.outcome, cardState, t]);

  const wakeSummary = readWakePolicySummary(action);
  const evidenceSummary = pickEvidenceSummary(action);
  const sourceRunId = readEvidenceRunId(action, "sourceRunId") ?? readEvidenceRunId(action, "latestRunId");
  const correctiveRunId = readEvidenceRunId(action, "correctiveRunId");
  const showAttempt = action.attemptCount > 1 && action.maxAttempts !== null;
  const showTimeoutInline = (() => {
    if (!action.timeoutAt) return false;
    try {
      const date = action.timeoutAt instanceof Date ? action.timeoutAt : new Date(action.timeoutAt);
      const diffMs = date.getTime() - Date.now();
      return diffMs > 0 && diffMs < 60 * 60 * 1000;
    } catch {
      return false;
    }
  })();
  const updatedAtLabel = formatTimeShort(action.updatedAt);

  const ariaState = ({
    needed: t("components.issueRecoveryActionCard.ariaStateNeeded", { defaultValue: "needed" }),
    in_progress: t("components.issueRecoveryActionCard.ariaStateInProgress", {
      defaultValue: "in progress",
    }),
    observe_only: t("components.issueRecoveryActionCard.ariaStateObserveOnly", {
      defaultValue: "observing active run",
    }),
    escalated: t("components.issueRecoveryActionCard.ariaStateEscalated", {
      defaultValue: "escalated",
    }),
    resolved: t("components.issueRecoveryActionCard.ariaStateResolved", {
      defaultValue: "resolved",
    }),
  } satisfies Record<RecoveryCardCardState, string>)[cardState];

  const showResolveActions = onResolve !== undefined && cardState !== "resolved";
  const visibleResolveOptions = getResolveOptions().filter((option) => {
    if (option.boardOnly && !canFalsePositive) return false;
    return true;
  });

  return (
    <section
      role="status"
      aria-label={t("components.issueRecoveryActionCard.sectionAriaLabel", {
        state: ariaState,
        defaultValue: "Recovery action: {{state}}",
      })}
      data-recovery-state={cardState}
      data-recovery-kind={action.kind}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-[0_1px_0_rgba(15,23,42,0.02)]",
        tone.containerClass,
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            tone.iconWrapClass,
          )}
          aria-hidden
        >
          <ToneIcon className={cn("h-4 w-4", tone.iconClass)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]">
            <span className={tone.labelClass}>{toneLabel}</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] tracking-normal text-muted-foreground">
              {getKindLabel()[action.kind] ?? action.kind}
            </code>
            {updatedAtLabel ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {updatedAtLabel}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-[14px] leading-6">{headline}</p>
        </div>
      </header>
      <dl className={cn("border-t bg-background/40 dark:bg-background/20", tone.divider)}>
        <MetadataRow
          label={t("components.issueRecoveryActionCard.rowLabelOwner", { defaultValue: "Owner" })}
        >
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {action.ownerType === "agent" && action.ownerAgentId ? (
              <>
                <span className="text-muted-foreground">
                  {t("components.issueRecoveryActionCard.ownerRecoveryPrefix", {
                    defaultValue: "Recovery:",
                  })}
                </span>
                <AgentLink agentId={action.ownerAgentId} agentMap={agentMap} />
              </>
            ) : action.ownerType === "board" ? (
              <span className="font-medium">
                {t("components.issueRecoveryActionCard.ownerBoard", { defaultValue: "Board" })}
              </span>
            ) : action.ownerType === "user" && action.ownerUserId ? (
              <span className="font-medium">
                {t("components.issueRecoveryActionCard.ownerUser", {
                  id: action.ownerUserId.slice(0, 6),
                  defaultValue: "user {{id}}",
                })}
              </span>
            ) : action.ownerType === "system" ? (
              <span className="font-medium">
                {t("components.issueRecoveryActionCard.ownerSystem", { defaultValue: "System" })}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t("components.issueRecoveryActionCard.ownerUnassigned", {
                  defaultValue: "unassigned — pick one to wake them",
                })}
              </span>
            )}
            {action.returnOwnerAgentId ? (
              <>
                <span className="text-muted-foreground">
                  {t("components.issueRecoveryActionCard.ownerReturnsTo", {
                    defaultValue: "→ Returns to:",
                  })}
                </span>
                <AgentLink agentId={action.returnOwnerAgentId} agentMap={agentMap} />
              </>
            ) : null}
          </span>
        </MetadataRow>
        <MetadataRow
          label={t("components.issueRecoveryActionCard.rowLabelSourceRun", {
            defaultValue: "Source run",
          })}
        >
          <RunChip runId={sourceRunId} agentId={action.previousOwnerAgentId} />
        </MetadataRow>
        {correctiveRunId ? (
          <MetadataRow
            label={t("components.issueRecoveryActionCard.rowLabelCorrectiveRun", {
              defaultValue: "Corrective run",
            })}
          >
            <RunChip runId={correctiveRunId} agentId={action.previousOwnerAgentId} />
          </MetadataRow>
        ) : null}
        <MetadataRow
          label={t("components.issueRecoveryActionCard.rowLabelEvidence", {
            defaultValue: "Evidence",
          })}
        >
          {evidenceSummary ? (
            <span className="break-words font-mono text-[11px] text-foreground/80">{evidenceSummary}</span>
          ) : (
            <MissingValue />
          )}
        </MetadataRow>
        <MetadataRow
          label={t("components.issueRecoveryActionCard.rowLabelNextAction", {
            defaultValue: "Next action",
          })}
        >
          {action.nextAction ? <span>{action.nextAction}</span> : <MissingValue />}
        </MetadataRow>
        <MetadataRow
          label={t("components.issueRecoveryActionCard.rowLabelWake", { defaultValue: "Wake" })}
        >
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {wakeSummary ? <span>{wakeSummary}</span> : <MissingValue />}
            {showAttempt ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("components.issueRecoveryActionCard.attemptOfMax", {
                  attempt: action.attemptCount,
                  max: action.maxAttempts,
                  defaultValue: "attempt {{attempt}} of {{max}}",
                })}
              </span>
            ) : null}
            {showTimeoutInline ? (
              <span className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("components.issueRecoveryActionCard.timesOut", {
                  when:
                    formatTimeShort(action.timeoutAt) ??
                    t("components.issueRecoveryActionCard.timesOutSoon", {
                      defaultValue: "soon",
                    }),
                  defaultValue: "Times out {{when}}",
                })}
              </span>
            ) : null}
          </span>
        </MetadataRow>
        {cardState === "resolved" && action.outcome ? (
          <MetadataRow
            label={t("components.issueRecoveryActionCard.rowLabelResolution", {
              defaultValue: "Resolution",
            })}
          >
            <span className={cn("font-medium", tone.labelClass)}>
              {t("components.issueRecoveryActionCard.resolvedAs", {
                outcome: getOutcomeLabel()[action.outcome],
                defaultValue: "Resolved as {{outcome}}",
              })}
              {action.resolvedAt ? ` · ${formatTimeShort(action.resolvedAt) ?? ""}` : ""}
            </span>
          </MetadataRow>
        ) : null}
      </dl>
      {showResolveActions ? (
        <div className={cn("flex flex-wrap items-center gap-2 border-t px-3 py-2.5 sm:px-4", tone.divider)}>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="default"
                data-testid="recovery-action-resolve-trigger"
                aria-label={t("components.issueRecoveryActionCard.resolveRecoveryAriaLabel", {
                  defaultValue: "Resolve recovery",
                })}
              >
                {t("components.issueRecoveryActionCard.resolveTrigger", {
                  defaultValue: "Resolve…",
                })}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="w-72 p-1.5"
            >
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t("components.issueRecoveryActionCard.resolveRecoveryHeading", {
                  defaultValue: "Resolve recovery",
                })}
              </div>
              <div className="flex flex-col">
                {visibleResolveOptions.map((option) => (
                  <button
                    key={option.outcome}
                    type="button"
                    onClick={() => onResolve?.(option.outcome)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      option.destructive ? "text-destructive" : null,
                    )}
                  >
                    <span className="font-medium leading-5">{option.label}</span>
                    <span className="text-[11px] leading-4 text-muted-foreground">{option.description}</span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {cardState === "observe_only" ? (
            <span className="text-[11px] text-muted-foreground">
              {t("components.issueRecoveryActionCard.observeOnlyHint", {
                defaultValue: "Recovery is observing without interrupting the live run.",
              })}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t("components.issueRecoveryActionCard.explicitDecisionHint", {
                defaultValue: "The card stays open until an explicit decision is recorded.",
              })}
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
}

export type { IssueRecoveryActionStatus };

export default IssueRecoveryActionCard;
