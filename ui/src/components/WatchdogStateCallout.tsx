import { useQuery } from "@tanstack/react-query";
import type {
  Agent,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueWatchdogProofOutcome,
  IssueWatchdogProofOutcomeSummary,
  IssueWatchdogSummary,
} from "@paperclipai/shared";
import { AlertTriangle, RefreshCw, ScanEye } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { issuesApi } from "@/api/issues";
import { cn, relativeTime } from "@/lib/utils";
import {
  WatchdogOutcomeBadge,
  watchdogOutcomeDotClass,
  watchdogOutcomeVerb,
} from "./WatchdogOutcomeBadge";

export interface WatchdogStateCalloutProps {
  issueId: string;
  /**
   * Lean watchdog summary from the issue payload. Signals that a watchdog
   * exists (so we mount + fetch the rich state); when null we render nothing.
   */
  watchdog: IssueWatchdogSummary | null | undefined;
  /** Open recovery action on the source issue — drives the failed "Outstanding" strip. */
  recoveryAction?: IssueRecoveryAction | null;
  /** Source issue's unresolved blockers — drives the deferred "Outstanding" strip. */
  blockers?: IssueRelationIssueSummary[];
  monitorNextCheckAt?: Date | string | null;
  agentMap?: ReadonlyMap<string, Agent>;
  className?: string;
}

const OUTCOME_CONTAINER: Record<IssueWatchdogProofOutcome, string> = {
  accepted:
    "border-emerald-300/70 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-500/10",
  restored:
    "border-teal-300/70 bg-teal-50/70 dark:border-teal-500/40 dark:bg-teal-500/10",
  deferred:
    "border-amber-300/70 bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-500/10",
  failed:
    "border-red-300/70 bg-red-50/70 dark:border-red-500/40 dark:bg-red-500/10",
  dismissed: "border-border bg-muted/40",
};

function shortFingerprint(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null;
  const trimmed = fingerprint.replace(/^[a-z_]+:/i, "");
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)}`;
}

function agentName(
  agentId: string | null | undefined,
  agentMap: ReadonlyMap<string, Agent> | undefined,
): string {
  if (!agentId) return "watchdog";
  return agentMap?.get(agentId)?.name ?? `${agentId.slice(0, 8)}`;
}

function issueLink(id: string, identifier: string | null | undefined): string {
  return `/issues/${identifier ?? id}`;
}

function outcomeStatement(
  outcome: IssueWatchdogProofOutcomeSummary,
  context: { hasOpenBlockers?: boolean; hasMonitor?: boolean } = {},
): string {
  const classification = outcome.resultClassification;
  switch (outcome.outcome) {
    case "accepted":
      return `Accepted the current stop as complete — the proof obligation passed (${classification}) and bounded evidence was persisted.`;
    case "restored":
      return "Restored live work inside the watched subtree and woke the responsible owner.";
    case "deferred":
      if (context.hasOpenBlockers) {
        return `Deferred verification — the proof obligation can't be checked yet (${classification}). It will re-check once, automatically, when the blocker resolves.`;
      }
      if (context.hasMonitor) {
        return `Deferred verification — the proof obligation can't be checked yet (${classification}). A scheduled follow-up will re-check it.`;
      }
      return `Deferred verification — the proof obligation can't be checked yet (${classification}). The waiting path must complete before verification can resume.`;
    case "failed":
      return `The proof obligation failed (${classification}). A recovery action was opened with the owner and next step.`;
    case "dismissed":
      return `Dismissed as a false positive (${classification}). Evidence was preserved; no action needed.`;
    default:
      return classification;
  }
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-3 py-1 text-xs sm:grid-cols-[10rem_1fr]">
      <dt className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function CalloutShell({
  tone,
  className,
  children,
}: {
  tone: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      role="status"
      aria-label="Watchdog state"
      data-testid="watchdog-state-callout"
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-[0_1px_0_rgba(15,23,42,0.02)]",
        tone,
        className,
      )}
    >
      {children}
    </section>
  );
}

function CalloutHeader({
  eyebrow,
  badge,
  statement,
}: {
  eyebrow: React.ReactNode;
  badge?: React.ReactNode;
  statement?: React.ReactNode;
}) {
  return (
    <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background/70 text-muted-foreground"
        aria-hidden
      >
        <ScanEye className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium normal-case tracking-normal text-muted-foreground">
            {eyebrow}
          </div>
          {badge ? <span className="ml-auto">{badge}</span> : null}
        </div>
        {statement ? <p className="mt-1 text-[14px] leading-6 text-foreground">{statement}</p> : null}
      </div>
    </header>
  );
}

export function WatchdogStateCallout({
  issueId,
  watchdog,
  recoveryAction,
  blockers,
  monitorNextCheckAt,
  agentMap,
  className,
}: WatchdogStateCalloutProps) {
  // Only mount/fetch when the issue payload already tells us a watchdog exists,
  // so non-watchdog issues never render a skeleton or fire an extra request.
  const hasWatchdog = !!watchdog;
  const query = useQuery({
    queryKey: ["issue", issueId, "watchdog"],
    queryFn: () => issuesApi.getWatchdog(issueId),
    enabled: hasWatchdog,
  });

  if (!hasWatchdog) return null;

  // State 7 — loading
  if (query.isLoading) {
    return (
      <CalloutShell tone="border-border bg-muted/30" className={className}>
        <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
          <Skeleton className="mt-0.5 h-7 w-7 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      </CalloutShell>
    );
  }

  // State 8 — load failure. Surfaced, never silently hidden.
  if (query.isError) {
    return (
      <CalloutShell tone="border-red-300/70 bg-red-50/60 dark:border-red-500/40 dark:bg-red-500/10" className={className}>
        <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" aria-hidden>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] leading-6 text-foreground">Couldn't load watchdog state.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 gap-1.5 text-xs"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={cn("h-3 w-3", query.isFetching && "animate-spin")} />
              Retry
            </Button>
          </div>
        </div>
      </CalloutShell>
    );
  }

  const data = query.data;
  if (!data) return null;

  const proof = data.latestProofOutcome ?? null;
  const wdAgent = agentName(data.watchdogAgentId, agentMap);
  const watchdogTaskHref = data.watchdogIssueId ? `/issues/${data.watchdogIssueId}` : null;
  const openBlockers = (blockers ?? []).filter((b) => b.status !== "done" && b.status !== "cancelled");
  const hasMonitor = !!monitorNextCheckAt;

  // State 6 — armed but no review yet
  if (!proof) {
    return (
      <CalloutShell tone="border-border bg-muted/40" className={className}>
        <CalloutHeader
          eyebrow={
            <>
              <span className="font-semibold uppercase tracking-[0.12em] text-foreground/80">Watchdog</span>
              <span className="text-muted-foreground/60" aria-hidden>·</span>
              <span>{wdAgent}</span>
            </>
          }
          statement={
            <>
              Watchdog armed. No review yet — the first outcome appears here when a durable stop is observed.
            </>
          }
        />
        {watchdogTaskHref ? (
          <dl className="border-t border-border bg-background/40 px-3 py-2 sm:px-4">
            <MetaRow label="Watchdog task">
              <Link to={watchdogTaskHref} className="font-medium underline-offset-2 hover:underline">
                Open watchdog task
              </Link>
            </MetaRow>
          </dl>
        ) : null}
      </CalloutShell>
    );
  }

  const reviewedShort = shortFingerprint(data.lastReviewedFingerprint);
  const observedShort = shortFingerprint(data.lastObservedFingerprint);
  const fingerprintDrift =
    !!data.lastObservedFingerprint &&
    !!data.lastReviewedFingerprint &&
    data.lastObservedFingerprint !== data.lastReviewedFingerprint;
  const evidenceEntries = Object.entries(proof.redactedDetails ?? {});

  return (
    <CalloutShell tone={OUTCOME_CONTAINER[proof.outcome] ?? OUTCOME_CONTAINER.dismissed} className={className}>
      <CalloutHeader
        eyebrow={
          <>
            <span className="font-semibold uppercase tracking-[0.12em] text-foreground/80">Watchdog</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <span>{wdAgent}</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <span>reviewed {relativeTime(proof.observedAt)}</span>
          </>
        }
        badge={<WatchdogOutcomeBadge outcome={proof.outcome} />}
        statement={outcomeStatement(proof, { hasOpenBlockers: openBlockers.length > 0, hasMonitor })}
      />
      <dl
        className={cn(
          "divide-y divide-border/60 border-t border-border bg-background/40 px-3 py-2 sm:px-4 dark:bg-background/20",
        )}
      >
        {reviewedShort ? (
          <MetaRow label="Fingerprint">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <code
                className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px]"
                title={data.lastReviewedFingerprint ?? undefined}
              >
                {reviewedShort}
              </code>
              {fingerprintDrift ? (
                <span
                  className="rounded border border-amber-300/70 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200"
                  title={`observed ${observedShort ?? ""} ≠ reviewed ${reviewedShort}`}
                >
                  observed fingerprint ahead — review pending
                </span>
              ) : null}
            </span>
          </MetaRow>
        ) : null}

        <MetaRow label="Proof method">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <code className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px]">{proof.method}</code>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                "border border-border bg-background/60",
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", watchdogOutcomeDotClass(proof.outcome))} aria-hidden />
              {proof.resultClassification}
            </span>
          </span>
        </MetaRow>

        {evidenceEntries.length > 0 ? (
          <MetaRow label="Evidence">
            <ul className="space-y-0.5">
              {evidenceEntries.map(([key, value]) => (
                <li key={key} className="flex flex-wrap items-baseline gap-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">{key}</span>
                  <code className="min-w-0 break-all rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px]">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </code>
                </li>
              ))}
            </ul>
          </MetaRow>
        ) : null}

        {proof.outcome === "deferred" ? (
          <OutstandingDeferred
            openBlockers={openBlockers}
            monitorNextCheckAt={monitorNextCheckAt}
          />
        ) : null}

        {proof.outcome === "failed" ? (
          <OutstandingFailed recoveryAction={recoveryAction} agentMap={agentMap} />
        ) : null}

        {watchdogTaskHref ? (
          <MetaRow label="Watchdog task">
            <Link to={watchdogTaskHref} className="font-medium underline-offset-2 hover:underline">
              Open watchdog task
            </Link>
          </MetaRow>
        ) : null}
      </dl>
    </CalloutShell>
  );
}

function OutstandingDeferred({
  openBlockers,
  monitorNextCheckAt,
}: {
  openBlockers: IssueRelationIssueSummary[];
  monitorNextCheckAt?: Date | string | null;
}) {
  const hasMonitor = !!monitorNextCheckAt;
  if (openBlockers.length === 0 && !hasMonitor) return null;
  return (
    <MetaRow label="Outstanding">
      <div className="rounded-md border border-amber-300/60 bg-background/50 px-2 py-1.5 dark:border-amber-500/30">
        {openBlockers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Blocked by</span>
            {openBlockers.map((b) => (
              <Link
                key={b.id}
                to={issueLink(b.id, b.identifier)}
                className="inline-flex items-center gap-1 rounded border border-amber-300/60 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 underline-offset-2 hover:underline dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200"
              >
                {b.identifier ?? b.id.slice(0, 8)}
                <span className="text-amber-700/70 dark:text-amber-300/70">{b.status}</span>
              </Link>
            ))}
          </div>
        ) : null}
        {hasMonitor ? (
          <div className="mt-1 text-[11px] text-muted-foreground">
            one-shot · next check {relativeTime(monitorNextCheckAt!)}
          </div>
        ) : (
          <div className="mt-1 text-[11px] text-muted-foreground">
            one-shot · next check on blocker resolve
          </div>
        )}
      </div>
    </MetaRow>
  );
}

function OutstandingFailed({
  recoveryAction,
  agentMap,
}: {
  recoveryAction?: IssueRecoveryAction | null;
  agentMap?: ReadonlyMap<string, Agent>;
}) {
  if (!recoveryAction) return null;
  const owner =
    recoveryAction.ownerType === "agent"
      ? agentName(recoveryAction.ownerAgentId, agentMap)
      : recoveryAction.ownerType === "board"
        ? "board"
        : recoveryAction.ownerType;
  return (
    <MetaRow label="Outstanding">
      <div className="rounded-md border border-red-300/60 bg-background/50 px-2 py-1.5 text-[11px] dark:border-red-500/30">
        <div className="flex flex-wrap items-center gap-1.5">
          {recoveryAction.recoveryIssueId ? (
            <Link
              to={`/issues/${recoveryAction.recoveryIssueId}`}
              className="rounded border border-red-300/60 bg-red-50 px-1.5 py-0.5 font-medium text-red-800 underline-offset-2 hover:underline dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200"
            >
              Recovery action
            </Link>
          ) : (
            <span className="font-medium text-foreground">Recovery action</span>
          )}
          <span className="text-muted-foreground">· {owner}</span>
        </div>
        <div className="mt-1 text-muted-foreground">next: {recoveryAction.nextAction}</div>
      </div>
    </MetaRow>
  );
}

export default WatchdogStateCallout;
