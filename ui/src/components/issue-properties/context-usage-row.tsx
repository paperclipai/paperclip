import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueContextCompaction, IssueContextUsage } from "@paperclipai/shared";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { useOptionalToastActions } from "../../context/ToastContext";
import { QueryErrorState, useQueryView } from "../QueryView";
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
    observedAt: value.observedAt,
    compactions: value.compactions,
  };
}

/** Maps the server's Compact now state, with a click in flight shown as pending. */
export function contextCompactState(
  compaction: IssueContextCompaction | undefined,
  requesting: boolean,
  onCompact: () => void,
): ContextCompactState | null {
  if (!compaction) return null;
  if (requesting || compaction.status === "pending") return { status: "pending" };
  if (compaction.status === "unavailable") {
    return { status: "unavailable", reason: compaction.reason ?? "Compaction is unavailable right now." };
  }
  return { status: "available", onCompact };
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
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const compact = useMutation({
    mutationFn: () => issuesApi.compactContext(issueId),
    onSettled: async () => {
      // The compaction runs as a short agent run; refresh the run state that
      // drives polling, then the reading itself.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.contextUsage(issueId, assigneeAgentId) }),
      ]);
    },
    onError: (error) => {
      toast?.pushToast({
        title: "Could not compact the context",
        body: error instanceof Error ? error.message : "Try again in a moment.",
        tone: "error",
      });
    },
  });
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
        <ContextUsageMeter
          usage={contextUsageFromIssue(view.data)}
          compact={contextCompactState(view.data.compaction, compact.isPending, () => compact.mutate())}
        />
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
