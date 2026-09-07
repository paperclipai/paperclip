import { t, useTranslation } from "@/i18n";
import { entityStatusLabel } from "@/lib/entity-labels";
import { Eye } from "lucide-react";
import type { IssueProductivityReview } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const TRIGGER_LABELS: Record<string, string> = {
  no_comment_streak: "localizationIssueChrome.reviewTriggerNoComment",
  long_active_duration: "localizationIssueChrome.reviewTriggerLongActive",
  high_churn: "localizationIssueChrome.reviewTriggerChurn",
};

const REVIEW_STATUS_LABELS: Record<string, string> = {
  todo: "Open",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  backlog: "Open",
};

export function productivityReviewTriggerLabel(
  trigger: IssueProductivityReview["trigger"],
): string {
  if (!trigger) return t("localizationIssueChrome.reviewTriggerDefault");
  return TRIGGER_LABELS[trigger] ? t(TRIGGER_LABELS[trigger]) : t("localizationIssueChrome.reviewTriggerDefault");
}

export function ProductivityReviewBadge({
  review,
  className,
  hideLabel = false,
}: {
  review: IssueProductivityReview;
  className?: string;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const label = productivityReviewTriggerLabel(review.trigger);
  const reviewIdentifier = review.reviewIdentifier ?? review.reviewIssueId.slice(0, 8);
  const reviewPath = createIssueDetailPath(review.reviewIdentifier ?? review.reviewIssueId);
  const statusLabel = review.status === "todo" || review.status === "backlog"
    ? t("localizationIssueChrome.reviewOpen")
    : REVIEW_STATUS_LABELS[review.status] ? entityStatusLabel(review.status) : review.status.replace(/_/g, " ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={reviewPath}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-(length:--text-nano) font-medium text-amber-700 dark:text-amber-300 shrink-0 hover:bg-amber-500/20 transition-colors",
            className,
          )}
          aria-label={t("localizationIssueChrome.reviewAria", { identifier: reviewIdentifier, trigger: label })}
        >
          <Eye className="h-3 w-3" aria-hidden />
          {hideLabel ? null : <span>{t("localizationIssueChrome.underReview")}</span>}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">{t("localizationIssueChrome.productivityReviewOpen")}</div>
          <div>
            <span className="text-muted-foreground">{t("localizationIssueChrome.triggerLabel")}</span> {label}
          </div>
          {typeof review.noCommentStreak === "number" && review.noCommentStreak > 0 ? (
            <div>
              <span className="text-muted-foreground">{t("localizationIssueChrome.noCommentLabel")}</span>{" "}
              {t("localizationIssueChrome.runs", { count: review.noCommentStreak })}
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">{t("localizationIssueChrome.reviewLabel")}</span> {reviewIdentifier} ({statusLabel})
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
