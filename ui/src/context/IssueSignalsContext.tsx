import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { attentionApi } from "../api/attention";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "./CompanyContext";

/**
 * The one per-issue signal a list row needs that no list already carries:
 * "this task has a pending issue-thread interaction and cannot move until a
 * human answers it" (ask_user_questions / request_confirmation /
 * suggest_tasks).
 *
 * Live runs are deliberately NOT here — lists already receive `liveIssueIds`
 * and render the Live badge through `InboxIssueMetaLeading`.
 *
 * The data comes from the company-wide attention feed that the sidebar already
 * calls (`GET /companies/:id/attention`), reusing the same query key so the two
 * consumers share one request. Every row then reads a map instead of fetching.
 *
 * The context defaults to "no signals", so `IssueRow` renders unchanged in unit
 * tests, in Storybook, and in any tree that does not mount the provider.
 */
export interface IssueSignals {
  awaiting: boolean;
  awaitingCount: number;
}

export const NO_ISSUE_SIGNALS: IssueSignals = { awaiting: false, awaitingCount: 0 };

/**
 * Exported so tests and Storybook can inject a map directly instead of
 * standing up a QueryClient and a company.
 */
export const IssueSignalsContext = createContext<ReadonlyMap<string, number>>(new Map<string, number>());

/**
 * Counts pending issue-thread interactions per issue.
 *
 * The attention feed unions many sources; only `issue_thread_interaction`
 * means "an agent is asking a human a question on this task". Approvals,
 * reviews and failed runs already have their own inbox rows and their own
 * affordances, so folding them into the same dot would make the dot mean
 * nothing in particular.
 */
export function buildAwaitingCounts(
  items: ReadonlyArray<{
    sourceKind?: string;
    subject?: { kind?: string; id?: string | null } | null;
    relatedIssue?: { kind?: string; id?: string | null } | null;
  }> | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items ?? []) {
    if (item.sourceKind !== "issue_thread_interaction") continue;
    const issueId = item.relatedIssue?.kind === "issue"
      ? item.relatedIssue.id
      : item.subject?.kind === "issue"
        ? item.subject.id
        : null;
    if (!issueId) continue;
    out.set(issueId, (out.get(issueId) ?? 0) + 1);
  }
  return out;
}

export function IssueSignalsProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();

  // Same key + queryFn as the sidebar's Decisions badge, so React Query serves
  // both from one request. Enabled without the Decisions experimental flag:
  // the pending-interaction dot is not part of that surface, it is the plain
  // "this task is waiting on you" marker.
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  const value = useMemo(() => buildAwaitingCounts(attentionFeed?.items), [attentionFeed]);

  return <IssueSignalsContext.Provider value={value}>{children}</IssueSignalsContext.Provider>;
}

export function useIssueSignals(issueId: string | null | undefined): IssueSignals {
  const awaitingCountByIssueId = useContext(IssueSignalsContext);
  return useMemo(() => {
    if (!issueId) return NO_ISSUE_SIGNALS;
    const awaitingCount = awaitingCountByIssueId.get(issueId) ?? 0;
    if (awaitingCount === 0) return NO_ISSUE_SIGNALS;
    return { awaiting: true, awaitingCount };
  }, [issueId, awaitingCountByIssueId]);
}
