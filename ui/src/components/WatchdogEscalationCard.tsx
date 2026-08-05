import { useState } from "react";
import type { Issue, IssueBlockedInboxIssueRef } from "@paperclipai/shared";
import { Loader2, OctagonAlert, RotateCcw, UserPlus, X } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DeadEndBadge } from "@/components/DeadEndBadge";
import { buildWatchdogEscalationView } from "@/lib/watchdog-escalation";

export interface WatchdogEscalationDeadEndRef {
  id: string;
  identifier: string | null;
  title: string;
}

export interface WatchdogEscalationCardProps {
  issue: Issue;
  /** Resolved display name for the watchdog agent (falls back to the agent id). */
  watchdogAgentName?: string | null;
  /** The dead-end leaf. Falls back to `issue.blockedInboxAttention.leafIssue`. */
  deadEndLeaf?: WatchdogEscalationDeadEndRef | IssueBlockedInboxIssueRef | null;
  /** Reopen the dead-end leaf to `todo` and wake its assignee. Hidden when absent. */
  onReopenDeadEnd?: () => void;
  /** Route the dead end to a different owner. Hidden when absent. */
  onReassign?: () => void;
  /** Suppress re-fire on this fingerprint. Requires a confirm + one-line reason. Hidden when absent. */
  onDismiss?: (reason: string) => void;
  reopenPending?: boolean;
  dismissPending?: boolean;
  className?: string;
}

function issueLink(ref: { id: string; identifier: string | null }): string {
  return `/issues/${ref.identifier ?? ref.id}`;
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function shortRunId(runId: string | null): string | null {
  if (!runId) return null;
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

/**
 * Danger-toned dismiss control. Silencing a watchdog is the exact failure mode from the incident, so
 * it is always a deliberate, audited choice: a confirm popover with a required, non-empty reason
 * (mirrors the audited break-glass pattern in `IssueRecoveryActionCard`).
 */
function DismissWithReason({
  onConfirm,
  pending,
}: {
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !pending;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          data-testid="watchdog-escalation-dismiss-trigger"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Dismiss
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        aria-labelledby="watchdog-dismiss-title"
        className="w-96 max-w-(--sz-calc-4) space-y-3 p-3"
      >
        <div className="space-y-1">
          <div
            id="watchdog-dismiss-title"
            className="flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-destructive"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Dismiss this escalation
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            This marks the stop legitimate and suppresses re-fire on this fingerprint. Record why —
            silencing a watchdog is always deliberate and audited.
          </p>
        </div>
        <div className="space-y-1">
          <Label
            htmlFor="watchdog-dismiss-reason"
            className="text-(length:--text-micro) text-muted-foreground"
          >
            Reason{" "}
            <span className="text-destructive">(required — recorded in the audit log)</span>
          </Label>
          <Textarea
            id="watchdog-dismiss-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. This stop is expected — the leaf is intentionally parked pending the Q3 launch."
            className="min-h-20 text-xs"
            data-testid="watchdog-escalation-dismiss-reason"
            aria-required="true"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="w-full"
          disabled={!canSubmit}
          data-testid="watchdog-escalation-dismiss-confirm"
          onClick={() => {
            if (!canSubmit) return;
            onConfirm(trimmed);
          }}
        >
          {pending ? "Dismissing…" : "Dismiss & suppress re-fire"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-(--gtc-10) gap-x-3 gap-y-0 py-1.5 text-xs sm:grid-cols-(--gtc-11)">
      <dt className="truncate text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/**
 * P6 surface 2b — the watchdog escalation attempt-history card. After N failed restoration attempts,
 * P4 stops re-firing and escalates; this card answers "why did the platform give up, and what
 * happened?" with a restoration-attempt timeline (when · action taken · outcome), plus the three
 * human actions: Reopen dead end, Reassign, Dismiss (confirm + reason). Clones the
 * `SourceResolvedFoldCallout` section/dl pattern, retoned to danger.
 */
export function WatchdogEscalationCard({
  issue,
  watchdogAgentName,
  deadEndLeaf,
  onReopenDeadEnd,
  onReassign,
  onDismiss,
  reopenPending = false,
  dismissPending = false,
  className,
}: WatchdogEscalationCardProps) {
  const view = buildWatchdogEscalationView(issue);
  if (!view || !view.escalated) return null;

  const leaf = deadEndLeaf ?? issue.blockedInboxAttention?.leafIssue ?? null;
  const watchedLabel = issue.identifier ?? issue.id.slice(0, 8);
  const watchdogLabel = watchdogAgentName ?? (view.watchdogAgentId ? `agent ${view.watchdogAgentId.slice(0, 8)}` : null);

  return (
    <section
      role="alert"
      aria-label="Watchdog escalation — automatic recovery exhausted"
      data-testid="watchdog-escalation-card"
      data-escalated="true"
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-(--shadow-extract-8)",
        "border-destructive/30 bg-destructive/5 text-foreground",
        className,
      )}
    >
      <header className="flex flex-col gap-3 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:px-4">
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive"
            aria-hidden
          >
            <OctagonAlert className="h-4 w-4 text-destructive" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-tight text-destructive">
              Watchdog escalated to a human — automatic recovery is exhausted
            </p>
            <p className="mt-1 text-sm leading-6 text-foreground/90">
              {view.attemptCount} of {view.maxAttempts} restoration attempts failed to move the tree
              forward. The platform has stopped re-firing to avoid a loop and is asking you to decide.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-10 sm:pl-0">
          {onReopenDeadEnd ? (
            <Button
              type="button"
              size="sm"
              variant="cta"
              disabled={reopenPending}
              data-testid="watchdog-escalation-reopen"
              onClick={onReopenDeadEnd}
            >
              {reopenPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              Reopen dead end
            </Button>
          ) : null}
          {onReassign ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="watchdog-escalation-reassign"
              onClick={onReassign}
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              Reassign
            </Button>
          ) : null}
          {onDismiss ? <DismissWithReason onConfirm={onDismiss} pending={dismissPending} /> : null}
        </div>
      </header>

      <dl
        className={cn(
          "divide-y border-t bg-background/40 px-3 py-2 sm:px-4 dark:bg-background/20",
          "border-destructive/25",
          "[&>*]:border-destructive/20",
        )}
      >
        <MetaRow label="Watched task">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Link
              to={issueLink(issue)}
              className="rounded-sm font-medium underline-offset-2 hover:underline"
            >
              {watchedLabel}
            </Link>
            <span className="text-muted-foreground">— {issue.title}</span>
          </span>
        </MetaRow>
        {leaf ? (
          <MetaRow label="Dead-end leaf">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Link to={issueLink(leaf)} className="rounded-sm underline-offset-2 hover:underline">
                <DeadEndBadge>{leaf.identifier ?? leaf.id.slice(0, 8)}</DeadEndBadge>
              </Link>
              <span className="min-w-0 break-words">{leaf.title}</span>
            </span>
          </MetaRow>
        ) : null}
        {watchdogLabel ? (
          <MetaRow label="Watchdog">
            <span className="font-medium">{watchdogLabel}</span>
          </MetaRow>
        ) : null}
        {view.fingerprintShort ? (
          <MetaRow label="Fingerprint">
            <span className="inline-flex flex-wrap items-baseline gap-1.5">
              <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground dark:bg-background/40">
                {view.fingerprintShort}
              </code>
              {view.fingerprintUnchangedAcrossAttempts ? (
                <span className="text-(length:--text-micro) text-muted-foreground">
                  (unchanged across all {view.attemptCount} attempts)
                </span>
              ) : null}
            </span>
          </MetaRow>
        ) : null}
      </dl>

      {view.attempts.length > 0 ? (
        <div className="border-t border-destructive/25 px-3 py-3 sm:px-4">
          <div className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            Restoration attempts
          </div>
          <ol className="space-y-3" data-testid="watchdog-escalation-attempts">
            {view.attempts.map((attempt) => {
              const when = formatTimestamp(attempt.completedAt);
              const run = shortRunId(attempt.runId);
              return (
                <li key={attempt.attempt} className="flex items-start gap-3">
                  <span
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-(length:--text-micro) font-semibold text-destructive"
                    aria-hidden
                  >
                    {attempt.attempt}
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      {when ? (
                        <span className="text-(length:--text-micro) text-muted-foreground">
                          {when}
                        </span>
                      ) : null}
                      {run ? (
                        <Link
                          to={
                            view.watchdogAgentId
                              ? `/agents/${view.watchdogAgentId}/runs/${attempt.runId}`
                              : issueLink(issue)
                          }
                          className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground underline-offset-2 hover:underline dark:bg-background/40"
                        >
                          run {run}
                        </Link>
                      ) : null}
                    </div>
                    <p className="text-sm leading-5">{attempt.mutationSummary}</p>
                    <p className="text-(length:--text-micro) leading-4 text-destructive/80">
                      →{" "}
                      {attempt.fingerprintUnchanged
                        ? "no leaf changed — the stop fingerprint did not move"
                        : "fingerprint changed after this write"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-destructive/25 px-3 py-2 text-(length:--text-micro) sm:px-4">
        <Badge
          variant="outline"
          className="border-destructive/40 bg-destructive/10 text-destructive"
        >
          <OctagonAlert className="h-3 w-3" aria-hidden />
          Escalated
        </Badge>
        <span className="text-muted-foreground">
          Reopen re-opens the dead-end leaf to todo and wakes its assignee. Reassign routes it to a
          different owner. Dismiss suppresses re-fire on this fingerprint (confirm + reason).
        </span>
      </div>
    </section>
  );
}

export default WatchdogEscalationCard;
