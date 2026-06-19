import type { ReactNode } from "react";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { buildIssueLabelParts } from "../lib/issue-labels";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";

export function IssueReferencePill({
  issue,
  strikethrough,
  className,
  children,
}: {
  issue: Pick<IssueRelationIssueSummary, "id" | "identifier" | "title"> &
    Partial<Pick<IssueRelationIssueSummary, "status">>;
  strikethrough?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const issuePathId = issue.identifier ?? issue.id;
  const labelParts = buildIssueLabelParts(issue);
  const classNames = cn(
    "paperclip-mention-chip paperclip-mention-chip--issue",
    "inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    issue.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
    strikethrough && "opacity-60 line-through decoration-muted-foreground",
    className,
  );
  const content = (
    <>
      {issue.status ? <StatusIcon status={issue.status} className="h-3 w-3 shrink-0" /> : null}
      {children !== undefined ? children : (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1">
          <span className="min-w-0 truncate">{labelParts.title}</span>
          {labelParts.identifierSuffix ? (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {labelParts.identifierSuffix}
            </span>
          ) : null}
        </span>
      )}
    </>
  );

  if (!issue.identifier) {
    return (
      <span
        data-mention-kind="issue"
        className={classNames}
        title={labelParts.text}
        aria-label={labelParts.ariaLabel}
      >
        {content}
      </span>
    );
  }

  return (
    <Link
      to={`/issues/${issuePathId}`}
      data-mention-kind="issue"
      className={classNames}
      title={labelParts.text}
      aria-label={labelParts.ariaLabel}
    >
      {content}
    </Link>
  );
}
