import { ShieldCheck } from "lucide-react";
import type { TaskChatAutoReview } from "./task-chat-model";

function riskText(review: TaskChatAutoReview): string | undefined {
  return review.riskLevel ? `${review.riskLevel} risk` : undefined;
}

/** Small trailing mark on a tool row that ran after an automatic approval review. */
export function AutoApprovedBadge({ review }: { review: TaskChatAutoReview }) {
  const risk = riskText(review);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-(length:--text-micro) text-muted-foreground"
      title={["Auto-review approved", risk, review.rationale].filter(Boolean).join(" · ")}
      data-testid="task-chat-auto-approved-badge"
    >
      <ShieldCheck className="size-3" aria-hidden="true" />
      <span>auto-approved</span>
    </span>
  );
}

/** The review record shown when the approved tool row is expanded. */
export function AutoReviewDetail({ review }: { review: TaskChatAutoReview }) {
  const facts = [riskText(review), review.userConsent ? `${review.userConsent} user authorization` : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid="task-chat-auto-review-detail">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        Auto-review approved{facts ? <span className="font-normal text-muted-foreground">· {facts}</span> : null}
      </p>
      {review.rationale ? <p className="whitespace-pre-wrap break-words">{review.rationale}</p> : null}
    </div>
  );
}
