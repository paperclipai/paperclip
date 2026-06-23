import { Eye } from "lucide-react";
import type { IssueProductivityReview } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { t, useTranslation } from "@/i18n";

function getTriggerLabels(): Record<string, string> {
  return {
    no_comment_streak: t("components.productivityReviewBadge.triggerNoCommentStreak", {
      defaultValue: "No-comment streak",
    }),
    long_active_duration: t("components.productivityReviewBadge.triggerLongActiveDuration", {
      defaultValue: "Long active duration",
    }),
    high_churn: t("components.productivityReviewBadge.triggerHighChurn", {
      defaultValue: "High churn",
    }),
  };
}

function getReviewStatusLabels(): Record<string, string> {
  return {
    todo: t("components.productivityReviewBadge.statusOpen", { defaultValue: "Open" }),
    in_progress: t("components.productivityReviewBadge.statusInProgress", {
      defaultValue: "In progress",
    }),
    in_review: t("components.productivityReviewBadge.statusInReview", { defaultValue: "In review" }),
    blocked: t("components.productivityReviewBadge.statusBlocked", { defaultValue: "Blocked" }),
    backlog: t("components.productivityReviewBadge.statusOpen", { defaultValue: "Open" }),
  };
}

export function productivityReviewTriggerLabel(
  trigger: IssueProductivityReview["trigger"],
): string {
  const fallback = t("components.productivityReviewBadge.productivityReview", {
    defaultValue: "Productivity review",
  });
  if (!trigger) return fallback;
  return getTriggerLabels()[trigger] ?? fallback;
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
  const statusLabel = getReviewStatusLabels()[review.status] ?? review.status.replace(/_/g, " ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={reviewPath}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 shrink-0 hover:bg-amber-500/20 transition-colors",
            className,
          )}
          aria-label={t("components.productivityReviewBadge.ariaLabel", {
            reviewIdentifier,
            label,
            defaultValue: "Under review · productivity review {{reviewIdentifier}} ({{label}})",
          })}
        >
          <Eye className="h-3 w-3" aria-hidden />
          {hideLabel ? null : (
            <span>
              {t("components.productivityReviewBadge.underReview", { defaultValue: "Under review" })}
            </span>
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">
            {t("components.productivityReviewBadge.productivityReviewOpen", {
              defaultValue: "Productivity review open",
            })}
          </div>
          <div>
            <span className="text-muted-foreground">
              {t("components.productivityReviewBadge.triggerLabel", { defaultValue: "Trigger:" })}
            </span>{" "}
            {label}
          </div>
          {typeof review.noCommentStreak === "number" && review.noCommentStreak > 0 ? (
            <div>
              <span className="text-muted-foreground">
                {t("components.productivityReviewBadge.noCommentStreakLabel", {
                  defaultValue: "No-comment streak:",
                })}
              </span>{" "}
              {t("components.productivityReviewBadge.runs", {
                count: review.noCommentStreak,
                defaultValue: "{{count}} runs",
                defaultValue_other: "{{count}} runs",
              })}
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">
              {t("components.productivityReviewBadge.reviewLabel", { defaultValue: "Review:" })}
            </span>{" "}
            {reviewIdentifier} ({statusLabel})
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
