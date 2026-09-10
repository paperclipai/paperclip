import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  ListChecks,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  DELIVERY_FINDING_DISPOSITIONS,
  type DeliveryFinding,
  type DeliveryFindingDisposition,
  type DeliveryReviewSummary,
  type DeliverySummary,
} from "@paperclipai/shared";
import { deliveryApi } from "../../api/delivery";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../../lib/utils";
import {
  DELIVERY_FINDING_DISPOSITION_LABELS,
  checkStatusTone,
  deliveryCheckLabel,
  deliveryToneBadge,
  findingDispositionLabel,
  findingStateLabel,
  isReviewStale,
  reviewStatusTone,
  shortSha,
} from "../../lib/delivery-display";
import { InlineBanner } from "../InlineBanner";
import { IssueStatusBadge } from "../StatusBadge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface TaskDeliveryPanelProps {
  issueId: string;
  companyId: string;
  className?: string;
  /** Called after a delivery mutation so the host can refresh issue-shaped data. */
  onDeliveryChanged?: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The delivery service did not respond.";
}

function ToneChip({ tone, children }: { tone: Parameters<typeof deliveryToneBadge>[0]; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        deliveryToneBadge(tone),
      )}
    >
      {children}
    </span>
  );
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-(length:--text-nano) font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

function MonoValue({ value, title }: { value: string; title?: string }) {
  return (
    <span className="font-mono text-xs" title={title ?? value}>
      {value}
    </span>
  );
}

function DeliveryFacts({ summary, companyId }: { summary: DeliverySummary; companyId: string }) {
  const owner = summary.ownerAgentId;
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(owner) && Boolean(companyId),
  });
  const ownerName = owner ? agents?.find((agent) => agent.id === owner)?.name ?? null : null;
  const missing = <span className="text-sm text-muted-foreground">—</span>;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      <FactRow label="Repository">
        {summary.repository ? <MonoValue value={summary.repository} /> : missing}
      </FactRow>
      <FactRow label="Target branch">
        {summary.targetBranch ? <MonoValue value={summary.targetBranch} /> : missing}
      </FactRow>
      <FactRow label="Delivery unit">
        {summary.unitId ? <MonoValue value={summary.unitId} /> : missing}
      </FactRow>
      <FactRow label="Owner">
        {owner ? (
          <span className="truncate" title={ownerName ?? owner}>
            {ownerName ?? <MonoValue value={owner} />}
          </span>
        ) : (
          missing
        )}
      </FactRow>
      <FactRow label="Pull request">
        {summary.prUrl ? (
          <a
            href={summary.prUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm underline underline-offset-2 hover:text-foreground"
          >
            {summary.prNumber ? `#${summary.prNumber}` : "Open PR"}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : summary.prNumber ? (
          <MonoValue value={`#${summary.prNumber}`} />
        ) : (
          missing
        )}
      </FactRow>
      <FactRow label="Head">
        {summary.headSha ? (
          <MonoValue value={shortSha(summary.headSha) ?? summary.headSha} title={summary.headSha} />
        ) : (
          missing
        )}
      </FactRow>
      <FactRow label="Queue position">
        {summary.queuePosition === null ? missing : <MonoValue value={`#${summary.queuePosition}`} />}
      </FactRow>
      <FactRow label="Last event">
        {summary.lastEventAt ? (
          <span title={formatDateTime(summary.lastEventAt)}>{relativeTime(summary.lastEventAt)}</span>
        ) : (
          missing
        )}
      </FactRow>
    </dl>
  );
}

function CheckList({ summary }: { summary: DeliverySummary }) {
  if (summary.checks.length === 0) {
    return <p className="text-sm text-muted-foreground">No checks reported for the current head yet.</p>;
  }
  return (
    <ul className="divide-y divide-border/60">
      {summary.checks.map((check) => {
        const tone = checkStatusTone(check.status);
        return (
          <li key={`${check.name}:${check.status}`} className="flex items-center gap-2 py-1.5">
            <ToneChip tone={tone}>{deliveryCheckLabel(check.status)}</ToneChip>
            <span className="min-w-0 flex-1 truncate text-sm" title={check.name}>
              {check.name}
            </span>
            {check.url ? (
              <a
                href={check.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Logs
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function DispositionForm({
  finding,
  pending,
  error,
  onSubmit,
}: {
  finding: DeliveryFinding;
  pending: boolean;
  error: string | null;
  onSubmit: (disposition: DeliveryFindingDisposition, explanation: string) => void;
}) {
  const [disposition, setDisposition] = useState<DeliveryFindingDisposition>("fixed");
  const [explanation, setExplanation] = useState("");
  const canSubmit = explanation.trim().length > 0 && !pending;
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border/70 bg-muted/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={disposition} onValueChange={(value) => setDisposition(value as DeliveryFindingDisposition)}>
          <SelectTrigger className="h-7 w-44 text-xs" aria-label="Disposition">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DELIVERY_FINDING_DISPOSITIONS.map((value) => (
              <SelectItem key={value} value={value} className="text-xs">
                {DELIVERY_FINDING_DISPOSITION_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-(length:--text-nano) text-muted-foreground">
          Finding <span className="font-mono">{finding.id.slice(0, 8)}</span>
        </span>
      </div>
      <Textarea
        value={explanation}
        onChange={(event) => setExplanation(event.currentTarget.value)}
        placeholder="What changed, or why this finding does not apply."
        aria-label="Disposition explanation"
        className="min-h-(--sz-60px) text-xs"
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" disabled={!canSubmit} onClick={() => onSubmit(disposition, explanation.trim())}>
          {pending ? "Recording…" : "Record disposition"}
        </Button>
      </div>
    </div>
  );
}

function FindingRow({
  finding,
  branchHeadSha,
  pending,
  error,
  onRecordDisposition,
}: {
  finding: DeliveryFinding;
  branchHeadSha: string | null;
  pending: boolean;
  error: string | null;
  onRecordDisposition: (disposition: DeliveryFindingDisposition, explanation: string) => void;
}) {
  const disposition = findingDispositionLabel(finding.disposition);
  const state = findingStateLabel(finding.state);
  const againstOlderHead = Boolean(finding.headSha && branchHeadSha && finding.headSha !== branchHeadSha);
  return (
    <li className="rounded-md border border-border/70 p-2">
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">
          {finding.title ?? "Finding"}
          {finding.filePath ? (
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {finding.filePath}
              {finding.line ? `:${finding.line}` : ""}
            </span>
          ) : null}
        </span>
        {finding.severity ? <ToneChip tone="neutral">{finding.severity}</ToneChip> : null}
        {state ? <ToneChip tone={finding.state === "open" ? "warning" : "neutral"}>{state}</ToneChip> : null}
        {disposition ? <ToneChip tone="neutral">{disposition}</ToneChip> : null}
        {finding.url ? (
          <a
            href={finding.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Open
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : null}
      </div>
      {againstOlderHead ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          Raised against head <MonoValue value={shortSha(finding.headSha) ?? ""} />, not the current head.
        </p>
      ) : null}
      {finding.body ? (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{finding.body}</p>
      ) : null}
      {finding.dispositionExplanation ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium">{disposition ?? "Recorded"}:</span> {finding.dispositionExplanation}
          {finding.dispositionAt ? (
            <span className="ml-1 opacity-80" title={formatDateTime(finding.dispositionAt)}>
              · {relativeTime(finding.dispositionAt)}
            </span>
          ) : null}
        </p>
      ) : (
        <DispositionForm finding={finding} pending={pending} error={error} onSubmit={onRecordDisposition} />
      )}
    </li>
  );
}

function ReviewSection({
  summary,
  review,
  reviewLoading,
  reviewError,
  reviewRefetch,
  feedbackPendingFindingId,
  feedbackError,
  onRecordDisposition,
}: {
  summary: DeliverySummary;
  review: DeliveryReviewSummary | undefined;
  reviewLoading: boolean;
  reviewError: unknown;
  reviewRefetch: () => void;
  feedbackPendingFindingId: string | null;
  feedbackError: { findingId: string; message: string } | null;
  onRecordDisposition: (findingId: string, disposition: DeliveryFindingDisposition, explanation: string) => void;
}) {
  const reviewedHeadSha = review?.reviewedHeadSha ?? summary.review.headSha;
  const branchHeadSha = review?.headSha ?? summary.headSha;
  const stale = isReviewStale(reviewedHeadSha, branchHeadSha);
  const findings = review?.findings ?? [];
  const blockingFindings = review?.blockingFindings ?? summary.review.blockingFindings;
  const reviewStatus = review?.status ?? summary.review.status;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">Review</h3>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={reviewRefetch}>
          <RefreshCw className="mr-1 h-3 w-3" aria-hidden />
          Refresh review
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ToneChip tone={reviewStatusTone(reviewStatus, blockingFindings)}>{reviewStatus || "unknown"}</ToneChip>
        <span className="text-muted-foreground">
          {blockingFindings === 0
            ? "No blocking findings"
            : `${blockingFindings} blocking ${blockingFindings === 1 ? "finding" : "findings"}`}
        </span>
        {summary.candidateGeneration !== null ? (
          <span className="text-xs text-muted-foreground">candidate #{summary.candidateGeneration}</span>
        ) : null}
        {reviewedHeadSha ? (
          <span className="text-xs text-muted-foreground">
            reviewed head <MonoValue value={shortSha(reviewedHeadSha) ?? reviewedHeadSha} />
          </span>
        ) : null}
        {review?.fetchedAt ? (
          <span className="text-xs text-muted-foreground" title={formatDateTime(review.fetchedAt)}>
            fetched {relativeTime(review.fetchedAt)}
          </span>
        ) : null}
      </div>
      {reviewStatus === "unknown" && branchHeadSha ? (
        <InlineBanner tone="warning" compact title="Review evidence is unknown">
          No fresh review evidence has been read for head <MonoValue value={shortSha(branchHeadSha) ?? ""} />, or
          the last read failed. This is not a pass: readiness stays revoked until an authoritative read succeeds.
        </InlineBanner>
      ) : null}
      {stale ? (
        <InlineBanner tone="warning" compact title="Review is stale">
          The recorded review is against head <MonoValue value={shortSha(reviewedHeadSha) ?? ""} />, but the
          branch head is <MonoValue value={shortSha(branchHeadSha) ?? ""} />. Readiness is revoked until the new
          head is reviewed.
        </InlineBanner>
      ) : null}
      {review?.nextAction ? (
        <p className="text-sm text-muted-foreground">Next action: {review.nextAction}</p>
      ) : null}
      {reviewLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : reviewError ? (
        <InlineBanner
          tone="danger"
          compact
          title="Scoped review unavailable"
          actions={
            <Button variant="outline" size="sm" onClick={reviewRefetch}>
              Retry
            </Button>
          }
        >
          {errorMessage(reviewError)}
        </InlineBanner>
      ) : findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings returned for the reviewed head.</p>
      ) : (
        <ul className="space-y-2">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              branchHeadSha={branchHeadSha}
              pending={feedbackPendingFindingId === finding.id}
              error={feedbackError?.findingId === finding.id ? feedbackError.message : null}
              onRecordDisposition={(disposition, explanation) =>
                onRecordDisposition(finding.id, disposition, explanation)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MergeReceipt({ summary }: { summary: DeliverySummary }) {
  const mergeEvent = useMemo(
    () => summary.events.find((event) => /merge/i.test(event.type)),
    [summary.events],
  );
  if (!summary.mergedSha) return null;
  return (
    <section className="rounded-md border border-border/70 bg-muted/30 p-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <GitMerge className="h-3.5 w-3.5" aria-hidden />
        Merge receipt
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Merged as <MonoValue value={shortSha(summary.mergedSha) ?? summary.mergedSha} /> into{" "}
        <MonoValue value={summary.targetBranch ?? "the target branch"} />
        {summary.repository ? (
          <>
            {" "}
            in <MonoValue value={summary.repository} />
          </>
        ) : null}
        .
      </p>
      {mergeEvent ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {mergeEvent.message} · {formatDateTime(mergeEvent.createdAt)}
        </p>
      ) : null}
    </section>
  );
}

function DeliveryTimeline({ summary }: { summary: DeliverySummary }) {
  const events = useMemo(
    () => [...summary.events].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [summary.events],
  );
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">Timeline</h3>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No delivery events recorded yet.</p>
      ) : (
        <ol className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="flex gap-2">
              <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-(length:--text-nano) uppercase tracking-(--tracking-caps) text-muted-foreground">
                    {event.type}
                  </span>
                  <span
                    className="text-(length:--text-nano) text-muted-foreground"
                    title={formatDateTime(event.createdAt)}
                  >
                    {relativeTime(event.createdAt)}
                  </span>
                </div>
                <p className="text-sm">
                  {event.message}
                  {event.url ? (
                    <a
                      href={event.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Open
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : null}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Task delivery evidence panel — the single surface for a task's automated
 * delivery state. Reads the native delivery endpoints; every mutation is a
 * governed operator action and every server rejection is shown verbatim.
 */
export function TaskDeliveryPanel({ issueId, companyId, className, onDeliveryChanged }: TaskDeliveryPanelProps) {
  const queryClient = useQueryClient();
  const deliveryQuery = useQuery({
    queryKey: queryKeys.delivery.issue(issueId),
    queryFn: () => deliveryApi.getIssueDelivery(issueId),
  });
  const summary = deliveryQuery.data;
  const reviewQuery = useQuery({
    queryKey: queryKeys.delivery.review(issueId),
    queryFn: () => deliveryApi.getIssueReview(issueId),
    enabled: Boolean(summary && (summary.codeDelivery || summary.phase !== "not_started")),
    retry: false,
  });
  const [feedbackPendingFindingId, setFeedbackPendingFindingId] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<{ findingId: string; message: string } | null>(null);

  const invalidateDelivery = () => {
    void queryClient.invalidateQueries({ queryKey: ["delivery"] });
    onDeliveryChanged?.();
  };

  const actionMutation = useMutation({
    mutationFn: (action: Parameters<typeof deliveryApi.actOnIssueDelivery>[1]) =>
      deliveryApi.actOnIssueDelivery(issueId, action),
    onSuccess: () => invalidateDelivery(),
  });

  const feedbackMutation = useMutation({
    mutationFn: (input: { findingId: string; disposition: DeliveryFindingDisposition; explanation: string }) =>
      deliveryApi.actOnIssueDelivery(issueId, {
        action: "feedback",
        findingId: input.findingId,
        disposition: input.disposition,
        explanation: input.explanation,
      }),
    onMutate: (input) => {
      setFeedbackPendingFindingId(input.findingId);
      setFeedbackError(null);
    },
    onSuccess: () => {
      setFeedbackPendingFindingId(null);
      invalidateDelivery();
    },
    onError: (error, input) => {
      setFeedbackPendingFindingId(null);
      setFeedbackError({ findingId: input.findingId, message: errorMessage(error) });
    },
  });

  if (deliveryQuery.isLoading) {
    return (
      <div className={cn("space-y-3", className)} aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (deliveryQuery.error) {
    return (
      <div className={cn("space-y-3", className)}>
        <InlineBanner
          tone="danger"
          title="Delivery state unavailable"
          actions={
            <Button variant="outline" size="sm" onClick={() => void deliveryQuery.refetch()}>
              Retry
            </Button>
          }
        >
          {errorMessage(deliveryQuery.error)}
        </InlineBanner>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className={cn("space-y-3", className)}>
        <InlineBanner tone="warning" title="No delivery summary">
          The delivery service returned no summary for this task.
        </InlineBanner>
      </div>
    );
  }

  const blocker = summary.blocker;
  const pauseActionPending =
    actionMutation.isPending &&
    (actionMutation.variables?.action === "pause" || actionMutation.variables?.action === "resume");
  const isDeliveryStarted = summary.codeDelivery || summary.phase !== "not_started";

  return (
    <div className={cn("space-y-5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <IssueStatusBadge status={summary.phase} />
        {summary.codeDelivery ? (
          <ToneChip tone="neutral">
            <GitPullRequest className="h-3 w-3" aria-hidden />
            Code delivery
          </ToneChip>
        ) : (
          <ToneChip tone="neutral">Non-code</ToneChip>
        )}
        <ToneChip tone={summary.artifactReady ? "success" : "warning"}>
          <ListChecks className="h-3 w-3" aria-hidden />
          {summary.artifactReady ? "Artifact ready" : "Artifact not ready"}
        </ToneChip>
        {summary.paused ? <ToneChip tone="warning">Delivery paused</ToneChip> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={actionMutation.isPending}
            onClick={() => actionMutation.mutate({ action: "reconcile" })}
          >
            <RefreshCw className="mr-1 h-3 w-3" aria-hidden />
            {actionMutation.isPending && actionMutation.variables?.action === "reconcile"
              ? "Reconciling…"
              : "Reconcile"}
          </Button>
          {isDeliveryStarted ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={actionMutation.isPending}
              onClick={() => actionMutation.mutate({ action: summary.paused ? "resume" : "pause" })}
            >
              {pauseActionPending ? "Updating…" : summary.paused ? "Resume delivery" : "Pause delivery"}
            </Button>
          ) : null}
        </div>
      </div>

      {actionMutation.error ? (
        <InlineBanner tone="danger" compact title="Delivery action failed">
          {errorMessage(actionMutation.error)}
        </InlineBanner>
      ) : null}

      {blocker ? (
        <InlineBanner
          tone="danger"
          title={
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {blocker.reasonCode}
            </span>
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={actionMutation.isPending}
              title="Bounded retry of the current delivery operation"
              onClick={() => actionMutation.mutate({ action: "retry" })}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
              {actionMutation.isPending && actionMutation.variables?.action === "retry" ? "Retrying…" : "Retry"}
            </Button>
          }
        >
          <p>{blocker.message}</p>
          {blocker.owner ? <p className="mt-1">Owner: {blocker.owner}</p> : null}
          {blocker.nextAction ? <p className="mt-1">Next action: {blocker.nextAction}</p> : null}
        </InlineBanner>
      ) : summary.nextAction ? (
        <InlineBanner tone="info" compact title="Next action">
          {summary.nextAction}
        </InlineBanner>
      ) : null}

      {!isDeliveryStarted ? (
        <InlineBanner tone="info" title="No delivery registered">
          This task has no delivery candidate yet. The framework publishes the candidate with its head SHA; the
          board cannot supply review or merge evidence.
        </InlineBanner>
      ) : (
        <>
          <DeliveryFacts summary={summary} companyId={companyId} />

          <Separator />

          <section className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">Checks</h3>
            <CheckList summary={summary} />
          </section>

          <Separator />

          <ReviewSection
            summary={summary}
            review={reviewQuery.data}
            reviewLoading={reviewQuery.isLoading}
            reviewError={reviewQuery.error}
            reviewRefetch={() => void reviewQuery.refetch()}
            feedbackPendingFindingId={feedbackPendingFindingId}
            feedbackError={feedbackError}
            onRecordDisposition={(findingId, disposition, explanation) =>
              feedbackMutation.mutate({ findingId, disposition, explanation })
            }
          />

          <MergeReceipt summary={summary} />

          <Separator />

          <DeliveryTimeline summary={summary} />
        </>
      )}
    </div>
  );
}
