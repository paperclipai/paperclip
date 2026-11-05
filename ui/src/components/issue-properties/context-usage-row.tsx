import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueContextUsage } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { ContextUsageMeter, type ContextCompactState, type ContextUsage } from "../ContextUsageMeter";
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
    compactions: value.compactions,
  };
}

/**
 * Context row for the task Properties panel. Renders nothing until the
 * agent's harness has reported a context window for this task.
 */
export function IssueContextUsageRow({
  issueId,
  hasActiveRun,
  compact,
}: {
  issueId: string;
  hasActiveRun: boolean;
  compact?: ContextCompactState | null;
}) {
  const query = useQuery({
    queryKey: queryKeys.issues.contextUsage(issueId),
    queryFn: () => issuesApi.getContextUsage(issueId),
    refetchInterval: hasActiveRun ? ACTIVE_RUN_REFRESH_MS : false,
    staleTime: hasActiveRun ? 0 : 60_000,
  });
  // Pick up the final measurement once the run settles.
  const wasActive = useRef(hasActiveRun);
  const { refetch } = query;
  useEffect(() => {
    if (wasActive.current && !hasActiveRun) void refetch();
    wasActive.current = hasActiveRun;
  }, [hasActiveRun, refetch]);
  if (!query.data) return null;
  return (
    <PropertyRow label="Context">
      <ContextUsageMeter usage={contextUsageFromIssue(query.data)} compact={compact} />
    </PropertyRow>
  );
}
