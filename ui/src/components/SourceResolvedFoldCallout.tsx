import { Sparkles } from "lucide-react";
import { Link } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";
import {
  type SourceResolvedWatchdogFold,
  formatCleanupOutcome,
  formatSilenceAgeMs,
  shortenEvidenceId,
} from "@/lib/source-resolved-watchdog-fold";

export interface SourceResolvedFoldCalloutProps {
  fold: SourceResolvedWatchdogFold;
  /** Time the run was finalized — used for the "system audit · {when}" header chip. */
  finalizedAt?: string | Date | null;
  className?: string;
}

function isoOrLocaleString(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function issueLink(id: string, identifier: string | null) {
  return `/issues/${identifier ?? id}`;
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-0 py-1 text-xs sm:grid-cols-[12rem_1fr]">
      <dt className="truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-status-success">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-status-success">{children}</dd>
    </div>
  );
}

export function SourceResolvedFoldCallout({
  fold,
  finalizedAt,
  className,
}: SourceResolvedFoldCalloutProps) {
  const sourceLabel = fold.sourceIssueIdentifier ?? fold.sourceIssueId.slice(0, 8);
  const evidenceShort = shortenEvidenceId(fold.sameRunEvidenceId);
  const evidenceAt = isoOrLocaleString(fold.sameRunEvidenceAt);
  const silenceAgeLabel = formatSilenceAgeMs(fold.silenceAgeMs);
  const silenceStartedLabel = isoOrLocaleString(fold.silenceStartedAt);
  const cleanupLabel = formatCleanupOutcome(fold.cleanup.outcome);
  const finalizedRelative = finalizedAt ? relativeTime(finalizedAt) : null;
  const evaluationLabel = fold.evaluationIssueIdentifier ?? fold.evaluationIssueId?.slice(0, 8);

  return (
    <section
      role="status"
      aria-label="Source-resolved watchdog fold"
      data-source-resolved-fold
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm",
        "border-status-success/30 bg-status-success/12 text-status-success",
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            "bg-status-success/20 text-status-success",
          )}
          aria-hidden
        >
          <Sparkles className="h-4 w-4 text-status-success" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em]">
            <span className="text-status-success">SOURCE-RESOLVED FOLD</span>
            <span className="text-muted-foreground/60" aria-hidden>·</span>
            <span className="font-medium normal-case tracking-normal text-muted-foreground">
              system audit
            </span>
            {finalizedRelative ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {finalizedRelative}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-[14px] leading-6">
            This run was folded as a source-resolved false positive.
          </p>
        </div>
      </header>
      <dl
        className={cn(
          "divide-y border-t bg-background/40 px-3 py-2 sm:px-4 dark:bg-background/20",
          "border-status-success/30",
          "[&>*]:border-status-success/20",
        )}
      >
        <MetaRow label="Source issue">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Link
              to={issueLink(fold.sourceIssueId, fold.sourceIssueIdentifier)}
              className="rounded-sm font-medium underline-offset-2 hover:underline"
            >
              {sourceLabel}
            </Link>
            <span className="rounded-md border border-status-success/30 bg-background/60 px-1.5 py-0.5 text-[11px] font-medium text-status-success">
              {fold.sourceIssueStatus}
            </span>
          </span>
        </MetaRow>
        <MetaRow label="Same-run evidence">
          <span className="inline-flex flex-wrap items-baseline gap-1.5">
            <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-status-success dark:bg-background/40">
              {fold.sameRunEvidenceKind}
            </span>
            <code
              className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-status-success dark:bg-background/40"
              title={fold.sameRunEvidenceId}
            >
              {evidenceShort}
            </code>
            {evidenceAt ? (
              <span className="text-[11px] text-muted-foreground">at {evidenceAt}</span>
            ) : null}
          </span>
        </MetaRow>
        <MetaRow label="Silence age before fold">
          {silenceAgeLabel ? (
            <span>
              {silenceAgeLabel}
              {silenceStartedLabel ? (
                <span className="text-muted-foreground"> (silence started {silenceStartedLabel})</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">unknown</span>
          )}
        </MetaRow>
        <MetaRow label="Process cleanup">
          <span
            className="inline-flex flex-wrap items-baseline gap-1.5"
            title={fold.cleanup.outcome}
          >
            <span>{cleanupLabel}</span>
            {fold.cleanup.error ? (
              <span className="text-muted-foreground">— {fold.cleanup.error}</span>
            ) : null}
          </span>
        </MetaRow>
        {fold.evaluationIssueId ? (
          <MetaRow label="Evaluation issue">
            <Link
              to={issueLink(fold.evaluationIssueId, fold.evaluationIssueIdentifier)}
              className="rounded-sm font-medium underline-offset-2 hover:underline"
            >
              {evaluationLabel}
            </Link>
          </MetaRow>
        ) : null}
      </dl>
    </section>
  );
}

export default SourceResolvedFoldCallout;
