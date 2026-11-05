import { useEffect, useRef } from "react";
import { RotateCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { IssueContextUsage } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
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
 * agent's harness has reported a context window for this task.
 */
export function IssueContextUsageRow({
  issueId,
  hasActiveRun,
}: {
  issueId: string;
  hasActiveRun: boolean;
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
  const retry = query.isError ? (
    <button
      type="button"
      onClick={() => void refetch()}
      disabled={query.isFetching}
      className="flex items-center gap-1 rounded-md px-1 text-xs text-destructive hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      data-testid="context-usage-retry"
      title="Retry loading the context window"
    >
      <RotateCw className="size-3" aria-hidden />
      {query.data ? "Retry" : "Couldn't load. Retry"}
    </button>
  ) : null;
  if (!query.data) return retry ? <PropertyRow label="Context">{retry}</PropertyRow> : null;
  return (
    <PropertyRow label="Context">
      <ContextUsageMeter usage={contextUsageFromIssue(query.data)} />
      {retry}
    </PropertyRow>
  );
}
