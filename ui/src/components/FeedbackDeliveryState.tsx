import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, RefreshCw } from "lucide-react";
import type {
  IssueCommentFeedbackDelivery,
  IssueFeedbackDeliveryRetryResponse,
} from "@paperclipai/shared";

import { InlineBanner } from "@/components/InlineBanner";
import { SystemNotice } from "@/components/SystemNotice";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";

/**
 * Doherty-threshold window. A first delivery that succeeds quickly stays
 * visually quiet: the retrying line only appears once the wait is long enough
 * for the operator to have noticed it.
 */
export const FEEDBACK_DELIVERY_RETRYING_REVEAL_MS = 400;

/** How long the ephemeral "Delivered after retry" confirmation stays visible. */
export const FEEDBACK_DELIVERY_TRANSIENT_SUCCESS_MS = 5000;

export function feedbackDeliveryRetryErrorMessage(
  response: IssueFeedbackDeliveryRetryResponse,
) {
  if (response.outcome !== "no_invokable_assignee") return response.message;
  if (response.reason === "paused") {
    return "The assigned agent is paused. Unpause the agent before retrying.";
  }
  if (response.reason === "pending_approval") {
    return "The assigned agent is waiting for approval. Approve or reassign it before retrying.";
  }
  return response.message;
}

const FEEDBACK_DELIVERY_STATES = [
  "retrying",
  "exhausted_needs_attention",
  "recovered_after_attention",
];

/**
 * Narrows the untyped `custom` bag a thread message carries. Thread metadata
 * crosses an `unknown` boundary, so the state string is validated rather than
 * cast — an unknown future state renders nothing instead of an empty shell.
 */
export function isIssueCommentFeedbackDelivery(
  value: unknown,
): value is IssueCommentFeedbackDelivery {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IssueCommentFeedbackDelivery>;
  return (
    typeof candidate.state === "string"
    && FEEDBACK_DELIVERY_STATES.includes(candidate.state)
    && typeof candidate.sourceCommentId === "string"
  );
}

/** Anchor id for deep-linking the attention queue straight at the banner. */
export const FEEDBACK_DELIVERY_ANCHOR_PREFIX = "feedback-delivery-";

export function feedbackDeliveryAnchorId(commentId: string) {
  return `${FEEDBACK_DELIVERY_ANCHOR_PREFIX}${commentId}`;
}

/**
 * Delay before claiming focus for a deep-linked banner. The thread's own
 * hash handling makes up to three scroll attempts over ~250ms; focusing inside
 * that window loses the focus to the thread viewport.
 */
const DEEP_LINK_FOCUS_SETTLE_MS = 350;

/**
 * Desktop constrains the notice to the same edge as the message body it belongs
 * to, so ownership is unambiguous when consecutive comments each carry one.
 * Mobile keeps the full thread width inside the thread's own padding.
 */
const FEEDBACK_DELIVERY_NOTICE_WIDTH = "w-full sm:max-w-(--pct-85)";

function shortRunId(runId: string) {
  return runId.slice(0, 8);
}

function runHref(delivery: IssueCommentFeedbackDelivery) {
  if (!delivery.targetRunId || !delivery.targetRunAgentId) return null;
  return `/agents/${delivery.targetRunAgentId}/runs/${delivery.targetRunId}`;
}

function deliveredTimeLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Countdown copy for the next automatic attempt. Preferred over
 * "Attempt 2 of 3" — one number is a lower cognitive load than two, and a
 * countdown answers the only question the operator actually has.
 */
function nextAttemptLabel(nextAttemptAt: string | null, now: number) {
  if (!nextAttemptAt) return null;
  const target = new Date(nextAttemptAt).getTime();
  if (Number.isNaN(target)) return null;
  const seconds = Math.round((target - now) / 1000);
  if (seconds <= 0) return null;
  if (seconds < 60) return `Next attempt in ${seconds}s`;
  return `Next attempt in ${Math.ceil(seconds / 60)}m`;
}

function attemptLabel(delivery: IssueCommentFeedbackDelivery) {
  if (delivery.attempt === null || delivery.maxAttempts === null) return null;
  // `attempt` counts completed generations; the in-flight one is the next.
  return `Attempt ${delivery.attempt + 1} of ${delivery.maxAttempts + 1}`;
}

/**
 * Tracks the transition out of `retrying` so quiet transient recovery can be
 * acknowledged without an attention item, a toast, or a thread event.
 *
 * The comment row owns this hook (not the status line) because the status line
 * unmounts exactly when the state it needs to report on disappears.
 */
export function useFeedbackDeliveryTransientSuccess(
  delivery: IssueCommentFeedbackDelivery | null | undefined,
) {
  const [showTransientSuccess, setShowTransientSuccess] = useState(false);
  const sawRetryingRef = useRef(false);

  const state = delivery?.state ?? null;
  useEffect(() => {
    if (state === "retrying") {
      sawRetryingRef.current = true;
      setShowTransientSuccess(false);
      return;
    }
    // Only celebrate a recovery the operator actually watched happen. An
    // exhausted promotion is not a success, and a delivery that was never
    // visibly retrying should leave no trace at all.
    if (state !== null || !sawRetryingRef.current) return;
    sawRetryingRef.current = false;
    setShowTransientSuccess(true);
    const timer = setTimeout(
      () => setShowTransientSuccess(false),
      FEEDBACK_DELIVERY_TRANSIENT_SUCCESS_MS,
    );
    return () => clearTimeout(timer);
  }, [state]);

  return showTransientSuccess;
}

/**
 * Quiet single-line delivery status for the source comment's footer/metadata
 * row. Renders nothing unless the comment is actually retrying (or just
 * recovered from retrying inside this session).
 */
export function FeedbackDeliveryFooterStatus({
  delivery,
  showTransientSuccess = false,
  align = "start",
  className,
}: {
  delivery?: IssueCommentFeedbackDelivery | null;
  showTransientSuccess?: boolean;
  align?: "start" | "end";
  className?: string;
}) {
  const isRetrying = delivery?.state === "retrying";
  const [revealed, setRevealed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRetrying) {
      setRevealed(false);
      return;
    }
    const timer = setTimeout(() => setRevealed(true), FEEDBACK_DELIVERY_RETRYING_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [isRetrying]);

  // Ticks the countdown copy. Cheap: one interval per retrying comment, and
  // retrying comments are rare and short-lived by construction.
  useEffect(() => {
    if (!revealed || !delivery?.nextAttemptAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [revealed, delivery?.nextAttemptAt]);

  if (isRetrying && !revealed) return null;
  if (!isRetrying && !showTransientSuccess) return null;

  const detail = isRetrying && delivery
    ? nextAttemptLabel(delivery.nextAttemptAt, now) ?? attemptLabel(delivery)
    : null;
  const runId = isRetrying && delivery?.targetRunId ? delivery.targetRunId : null;
  const href = isRetrying && delivery ? runHref(delivery) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="feedback-delivery-footer-status"
      data-state={isRetrying ? "retrying" : "delivered_after_retry"}
      className={cn(
        "mt-1 flex flex-wrap items-center gap-1.5 px-1 text-(length:--text-micro) text-muted-foreground",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      {isRetrying ? (
        <RefreshCw
          className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <CircleCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      <span>{isRetrying ? "Retrying feedback delivery…" : "Delivered after retry"}</span>
      {detail ? <span aria-hidden="true">·</span> : null}
      {detail ? <span>{detail}</span> : null}
      {runId ? <span aria-hidden="true">·</span> : null}
      {runId ? (
        href ? (
          <Link
            to={href}
            className="font-mono underline-offset-2 hover:text-foreground hover:underline focus-visible:underline"
          >
            Run {shortRunId(runId)}
          </Link>
        ) : (
          <span className="font-mono">Run {shortRunId(runId)}</span>
        )
      ) : null}
    </div>
  );
}

/**
 * Persistent, actionable delivery notice rendered directly under the human
 * comment it describes: the warning banner while delivery needs attention, and
 * the historical recovered notice once it no longer does.
 *
 * Only ever one of the two renders — the operator never sees both.
 */
export function FeedbackDeliveryNotice({
  delivery,
  onRetry,
  retryPending = false,
  retryError = null,
  className,
}: {
  delivery: IssueCommentFeedbackDelivery;
  onRetry?: (commentId: string) => void;
  retryPending?: boolean;
  retryError?: string | boolean | null;
  className?: string;
}) {
  const anchorId = feedbackDeliveryAnchorId(delivery.sourceCommentId);
  const headingRef = useRef<HTMLSpanElement>(null);
  const href = runHref(delivery);
  const runId = delivery.targetRunId;

  // Arriving from the attention queue: `#feedback-delivery-<id>` should land
  // the operator on the banner heading, not merely scroll it into view.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== `#${anchorId}`) return;
    const timer = setTimeout(() => headingRef.current?.focus(), DEEP_LINK_FOCUS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [anchorId]);

  if (delivery.state === "recovered_after_attention") {
    const deliveredAt = delivery.deliveredAt ? deliveredTimeLabel(delivery.deliveredAt) : null;
    return (
      <div
        id={anchorId}
        data-testid="feedback-delivery-recovered"
        className={cn(FEEDBACK_DELIVERY_NOTICE_WIDTH, className)}
      >
        <SystemNotice
          tone="success"
          label="Feedback delivered"
          body={
            <span>
              Recovered after delivery needed attention.
              {deliveredAt ? <> Delivered {deliveredAt}.</> : null}
            </span>
          }
          source={
            runId
              ? { label: `Run ${shortRunId(runId)}`, ...(href ? { href } : {}) }
              : undefined
          }
        />
      </div>
    );
  }

  if (delivery.state !== "exhausted_needs_attention") return null;

  const retrying = retryPending || delivery.retryInFlight;
  const lastAttempt = delivery.lastAttemptAt ? timeAgo(delivery.lastAttemptAt) : null;
  const batchNote = delivery.batchedCommentCount > 1
    ? `Covers ${delivery.batchedCommentCount} comments.`
    : null;

  return (
    <div
      id={anchorId}
      data-testid="feedback-delivery-exhausted"
      className={cn(FEEDBACK_DELIVERY_NOTICE_WIDTH, className)}
    >
      {/* Announced once on transition, not on every rerender of the banner. */}
      <span role="alert" className="sr-only">
        Feedback wasn&apos;t delivered. Paperclip stopped retrying.
      </span>
      <InlineBanner
        compact
        tone="warning"
        title={
          <span ref={headingRef} tabIndex={-1}>
            Feedback wasn&apos;t delivered
          </span>
        }
        actions={
          <>
            {delivery.canRetry || retrying ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="feedback-delivery-retry"
                className="min-h-11 w-full sm:min-h-0 sm:w-auto"
                disabled={retrying || !onRetry}
                onClick={() => onRetry?.(delivery.sourceCommentId)}
              >
                {retrying ? "Retrying…" : "Retry delivery"}
              </Button>
            ) : null}
            {/* Omitted entirely when there is no authorized run route — never a
                disabled mystery action. */}
            {href ? (
              <Button
                asChild
                size="sm"
                variant="ghost"
                className="min-h-11 w-full sm:min-h-0 sm:w-auto"
              >
                <Link to={href}>View run</Link>
              </Button>
            ) : null}
          </>
        }
      >
        <div className="space-y-1">
          <p>Paperclip stopped retrying. The agent may not have seen this comment.</p>
          {delivery.safeFailureReason ? <p>{delivery.safeFailureReason}</p> : null}
          <p className="flex flex-wrap items-center gap-1.5 text-(length:--text-micro)">
            {lastAttempt ? <span>Last attempt {lastAttempt}</span> : null}
            {lastAttempt && runId ? <span aria-hidden="true">·</span> : null}
            {runId ? <span className="font-mono">Run {shortRunId(runId)}</span> : null}
            {batchNote ? <span aria-hidden="true">·</span> : null}
            {batchNote ? <span>{batchNote}</span> : null}
          </p>
          {retryError ? (
            <p data-testid="feedback-delivery-retry-error" className="font-medium">
              {typeof retryError === "string"
                ? retryError
                : "Couldn't start another retry. Try again."}
            </p>
          ) : null}
        </div>
      </InlineBanner>
    </div>
  );
}
