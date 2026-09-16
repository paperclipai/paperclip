import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { badgeVariants } from "./ui/badge";
import { StatusIcon } from "./StatusIcon";

export function IssueReferencePill({
  issue,
  strikethrough,
  className,
  children,
  onRemove,
  variant = "mention",
}: {
  issue: Pick<IssueRelationIssueSummary, "id" | "identifier" | "title"> &
    { status?: string };
  strikethrough?: boolean;
  variant?: "mention" | "property";
  className?: string;
  children?: ReactNode;
  /** Reserves space for a separate hover/focus action without moving the task link. */
  onRemove?: (issueId: string) => void;
}) {
  const issueLabel = issue.identifier ?? issue.title;
  const classNames = cn(
    variant === "property" || onRemove
      ? cn(badgeVariants({ variant: "outline" }), "min-w-0 max-w-full shrink font-normal no-underline")
      : "paperclip-mention-chip paperclip-mention-chip--issue inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    issue.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
    onRemove && "pr-6",
    strikethrough && "opacity-60 line-through decoration-muted-foreground",
    className,
  );
  const content = (
    <>
      {issue.status ? <StatusIcon status={issue.status} className="h-3 w-3 shrink-0" /> : null}
      {children !== undefined ? children : <span className="min-w-0 truncate">{issue.identifier ?? issue.title}</span>}
    </>
  );

  if (onRemove) {
    return (
      <span className="group/issue-reference relative inline-flex min-w-0 max-w-full">
        <Link
          to={`/issues/${issue.identifier ?? issue.id}`}
          disableIssueQuicklook
          data-mention-kind="issue"
          className={cn(classNames, "min-w-0 max-w-full")}
          title={issue.title}
          aria-label={`Task ${issueLabel}: ${issue.title}`}
        >
          {content}
        </Link>
        <button
          type="button"
          className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/issue-reference:opacity-100 group-focus-within/issue-reference:opacity-100 pointer-coarse:opacity-100"
          aria-label={`Remove ${issueLabel} as blocker`}
          title={`Remove ${issueLabel} as blocker`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(issue.id);
          }}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </span>
    );
  }

  if (!issue.identifier && variant === "mention") {
    return (
      <span
        data-mention-kind="issue"
        className={classNames}
        title={issue.title}
        aria-label={`Task: ${issue.title}`}
      >
        {content}
      </span>
    );
  }

  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}`}
      disableIssueQuicklook={variant === "property"}
      data-mention-kind="issue"
      className={classNames}
      title={issue.title}
      aria-label={`Task ${issueLabel}: ${issue.title}`}
    >
      {content}
    </Link>
  );
}
