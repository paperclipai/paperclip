import { Eye } from "lucide-react";
import type { IssueProductivityReview } from "@paperclipai/shared";
import type { TFunction } from "i18next";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { useTranslation } from "@/i18n";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

function triggerLabel(t: TFunction, trigger: IssueProductivityReview["trigger"]): string {
  if (!trigger) return t("productivityReviewBadge.title", { defaultValue: "Productivity review" });
  switch (trigger) {
    case "no_comment_streak":
      return t("productivityReviewBadge.trigger.noCommentStreak", { defaultValue: "No-comment streak" });
    case "long_active_duration":
      return t("productivityReviewBadge.trigger.longActiveDuration", { defaultValue: "Long active duration" });
    case "high_churn":
      return t("productivityReviewBadge.trigger.highChurn", { defaultValue: "High churn" });
    default:
      return t("productivityReviewBadge.title", { defaultValue: "Productivity review" });
  }
}

function statusLabelFor(t: TFunction, status: IssueProductivityReview["status"]): string {
  switch (status) {
    case "todo":
      return t("productivityReviewBadge.status.open", { defaultValue: "Open" });
    case "in_progress":
      return t("productivityReviewBadge.status.inProgress", { defaultValue: "In progress" });
    case "in_review":
      return t("productivityReviewBadge.status.inReview", { defaultValue: "In review" });
    case "blocked":
      return t("productivityReviewBadge.status.blocked", { defaultValue: "Blocked" });
    case "backlog":
      return t("productivityReviewBadge.status.open", { defaultValue: "Open" });
    default:
      return status.replace(/_/g, " ");
  }
}

export function productivityReviewTriggerLabel(
  t: TFunction,
  trigger: IssueProductivityReview["trigger"],
): string {
  return triggerLabel(t, trigger);
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
  const label = triggerLabel(t, review.trigger);
  const reviewIdentifier = review.reviewIdentifier ?? review.reviewIssueId.slice(0, 8);
  const reviewPath = createIssueDetailPath(review.reviewIdentifier ?? review.reviewIssueId);
  const statusLabel = statusLabelFor(t, review.status);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={reviewPath}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 shrink-0 hover:bg-amber-500/20 transition-colors",
            className,
          )}
          aria-label={t("productivityReviewBadge.ariaLabel", {
            defaultValue: "Under review · productivity review {{identifier}} ({{label}})",
            identifier: reviewIdentifier,
            label,
          })}
        >
          <Eye className="h-3 w-3" aria-hidden />
          {hideLabel ? null : <span>{t("productivityReviewBadge.underReview", { defaultValue: "Under review" })}</span>}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">{t("productivityReviewBadge.open", { defaultValue: "Productivity review open" })}</div>
          <div>
            <span className="text-muted-foreground">{t("productivityReviewBadge.triggerLabel", { defaultValue: "Trigger:" })}</span> {label}
          </div>
          {typeof review.noCommentStreak === "number" && review.noCommentStreak > 0 ? (
            <div>
              <span className="text-muted-foreground">{t("productivityReviewBadge.noCommentStreakLabel", { defaultValue: "No-comment streak:" })}</span>{" "}
              {t("productivityReviewBadge.runs", { defaultValue: "{{count}} runs", count: review.noCommentStreak })}
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">{t("productivityReviewBadge.reviewLabel", { defaultValue: "Review:" })}</span> {reviewIdentifier} ({statusLabel})
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
