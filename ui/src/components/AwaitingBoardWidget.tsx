import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { PriorityIcon } from "./PriorityIcon";
import { timeAgo } from "../lib/timeAgo";
import { Inbox } from "lucide-react";

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortByPriority(issues: Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
  );
}

interface AwaitingBoardWidgetProps {
  companyId: string;
}

export function AwaitingBoardWidget({ companyId }: AwaitingBoardWidgetProps) {
  const { data: inReviewIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId), "awaiting-board"],
    queryFn: () => issuesApi.list(companyId, { status: "in_review" }),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const awaitingItems = useMemo(
    () => sortByPriority(inReviewIssues ?? []),
    [inReviewIssues],
  );

  if (awaitingItems.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-amber-600 dark:text-amber-400">
        <Inbox className="h-4 w-4" />
        <h3 className="text-sm font-semibold uppercase tracking-wide">
          Awaiting Your Response
        </h3>
        <span className="ml-auto text-xs font-mono text-muted-foreground">
          {awaitingItems.length}
        </span>
      </div>
      <div className="border border-amber-300 dark:border-amber-500/40 divide-y divide-amber-200 dark:divide-amber-500/20 overflow-hidden rounded-md bg-amber-50/50 dark:bg-amber-950/20">
        {awaitingItems.map((issue) => (
          <Link
            key={issue.id}
            to={`/issues/${issue.identifier ?? issue.id}`}
            className="px-3 py-2.5 text-sm cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-900/30 transition-colors no-underline text-inherit flex items-start gap-2"
          >
            <span className="shrink-0 mt-0.5">
              <PriorityIcon priority={issue.priority} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block truncate font-medium text-sm leading-snug">
                {issue.title}
              </span>
              <span className="flex items-center gap-2 mt-1">
                <span className="text-xs font-mono text-muted-foreground">
                  {issue.identifier ?? issue.id.slice(0, 8)}
                </span>
                <span className="text-xs text-amber-700 dark:text-amber-400 ml-auto shrink-0">
                  waiting {timeAgo(issue.updatedAt)}
                </span>
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
