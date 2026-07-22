import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { Link } from "@/lib/router";
import { decisionsApi } from "../api/decisions";
import { queryKeys } from "../lib/queryKeys";

/**
 * Information-scent breadcrumb on a target issue: when a decision proposed
 * *elsewhere* targets this issue (via `decision_target_issues`), surface it so
 * the pending decision isn't lost in another thread. It never actuates inline —
 * decisions are always decided from the one Decisions inbox (PAP-14966 §3).
 */
export function PendingDecisionStrip({ companyId, issueId }: { companyId: string; issueId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.decisions.forTargetIssue(companyId, issueId),
    queryFn: () => decisionsApi.list(companyId, { targetIssueId: issueId, status: "open" }),
    enabled: !!companyId && !!issueId,
  });

  const count = data?.length ?? 0;
  if (count === 0) return null;

  // Deep-link to the single decision when there's just one; otherwise the inbox.
  const to = count === 1 ? `/decisions?decisionId=${data![0]!.id}` : "/decisions";

  return (
    <Link
      to={to}
      className="flex items-center gap-2 rounded-lg border-l-2 border-violet-500/60 bg-violet-500/5 px-3 py-2 text-sm text-violet-900 transition-colors hover:bg-violet-500/10 dark:text-violet-100"
    >
      <Scale className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
      <span className="font-medium">
        {count === 1 ? "1 pending decision affects this issue" : `${count} pending decisions affect this issue`}
      </span>
      <span className="text-xs text-muted-foreground">Review in Decisions →</span>
    </Link>
  );
}
