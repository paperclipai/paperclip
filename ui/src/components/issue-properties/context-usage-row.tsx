import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueContextUsage } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { QueryErrorState, useQueryView } from "../QueryView";
import { ContextUsageMeter, type ContextUsage } from "../ContextUsageMeter";
import { PropertyRow } from "./primitives";

/** Refresh cadence while an agent run is reporting usage. */
const ACTIVE_RUN_REFRESH_MS = 8_000;

export function contextUsageFromIssue(value: IssueContextUsage): ContextUsage {
  return {
    usedTokens: value.usedTokens,
    contextWindow: value.windowTokens,
    totals: value.totals
      ? {
          inputTokens: value.totals.inputTokens,
          cachedInputTokens: value.totals.cachedInputTokens,
          outputTokens: value.totals.outputTokens,
        }
      : null,
    costUsd: value.costUsd,
    observedAt: value.observedAt,
    compactions: value.compactions,
  };
}

/**
 * Context row for the task Properties panel. Renders nothing until the
 * agent's harness has reported a context window for this task. A cached
 * reading stays visible through a failed refresh; a failed first load shows
 * the shared error state with Retry.
 */
export function IssueContextUsageRow({
  issueId,
  assigneeAgentId,
  hasActiveRun,
}: {
  issueId: string;
  /** The reading belongs to the assignee's session, so a reassignment refetches it. */
  assigneeAgentId: string | null;
  hasActiveRun: boolean;
}) {
  const query = useQuery({
    queryKey: queryKeys.issues.contextUsage(issueId, assigneeAgentId),
    queryFn: () => issuesApi.getContextUsage(issueId),
    refetchInterval: hasActiveRun ? ACTIVE_RUN_REFRESH_MS : false,
    staleTime: hasActiveRun ? 0 : 60_000,
  });
  const view = useQueryView(query);
  // Pick up the final measurement once the run settles.
  const wasActive = useRef(hasActiveRun);
  const { refetch } = query;
  useEffect(() => {
    if (wasActive.current && !hasActiveRun) void refetch();
    wasActive.current = hasActiveRun;
  }, [hasActiveRun, refetch]);

  if (view.data) {
    return (
      <PropertyRow label="Context">
        <ContextUsageMeter usage={contextUsageFromIssue(view.data)} />
      </PropertyRow>
    );
  }
  if (view.kind !== "error") return null;
  return (
    <PropertyRow label="Context">
      <QueryErrorState
        error={view.error}
        size="inline"
        action="load the context window"
        onRetry={view.retry}
        retrying={view.isFetching}
      />
    </PropertyRow>
  );
}
