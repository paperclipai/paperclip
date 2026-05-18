import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import type { IssueSiblingNavigation as IssueSiblingNavigationState } from "@/lib/issue-detail-subissues";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "@/lib/issueDetailBreadcrumb";
import { cn } from "@/lib/utils";
import { Link } from "@/lib/router";
import { StatusIcon } from "./StatusIcon";

type IssueSiblingNavigationProps = {
  navigation: IssueSiblingNavigationState | null;
  linkState?: unknown;
};

export function IssueSiblingNavigation({ navigation, linkState }: IssueSiblingNavigationProps) {
  if (!navigation) return null;

  return (
    <nav
      aria-label="Sub-issue navigation"
      className="mt-4 flex flex-col gap-3 sm:mt-6 sm:grid sm:grid-cols-2"
    >
      {navigation.previous ? (
        <SiblingLink direction="previous" issue={navigation.previous} linkState={linkState} />
      ) : null}
      {navigation.next ? (
        <SiblingLink
          direction="next"
          issue={navigation.next}
          linkState={linkState}
          className={!navigation.previous ? "sm:col-start-2" : undefined}
        />
      ) : null}
    </nav>
  );
}

function SiblingLink({
  direction,
  issue,
  linkState,
  className,
}: {
  direction: "previous" | "next";
  issue: Issue;
  linkState?: unknown;
  className?: string;
}) {
  const issuePathId = issue.identifier ?? issue.id;
  const label = direction === "previous" ? "Previous" : "Next";
  const ariaDirection = direction === "previous" ? "Previous sub-issue" : "Next sub-issue";
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;

  return (
    <Link
      to={createIssueDetailPath(issuePathId)}
      state={withIssueDetailHeaderSeed(linkState, issue)}
      issuePrefetch={issue}
      issueQuicklookSide="top"
      issueQuicklookAlign={direction === "previous" ? "start" : "end"}
      aria-label={`${ariaDirection}: ${identifier} - ${issue.title}`}
      className={cn(
        "group min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 text-left no-underline transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
        direction === "next" && "sm:text-right",
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <div className={cn(
          "flex items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground",
          direction === "next" && "sm:justify-end",
        )}>
          {direction === "previous" ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
          <span>{label}</span>
          {direction === "next" ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
        </div>
        <div className={cn(
          "flex min-w-0 items-center gap-1.5 text-xs font-mono text-muted-foreground transition-colors group-hover:text-foreground",
          direction === "next" && "sm:justify-end",
        )}>
          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
          <span className="shrink-0">{identifier}</span>
        </div>
        <div className="truncate text-sm text-foreground">
          {issue.title}
        </div>
      </div>
    </Link>
  );
}
