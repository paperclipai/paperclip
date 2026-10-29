import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { DecisionHistoryItem, DecisionHistoryPage } from "@paperclipai/shared";
import { ArrowUpRight, Check, MessageSquare, RotateCcw, X } from "lucide-react";
import { api, detachInflightGet } from "@/api/client";
import { Link } from "@/lib/router";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { CoordinatorRelativeTime } from "./CoordinatorRelativeTime";
import { Button } from "@/components/ui/button";

export function useCoordinatorChatDecisionReceipts(issueId: string | null, conversationMode: boolean | undefined) {
  const { enabled, userId } = useCoordinatorWorkspaceEnabled();
  const query = useInfiniteQuery({
    queryKey: ["issues", "decision-receipts", issueId, userId],
    enabled: enabled && !!issueId && !!userId && conversationMode === true,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: "100" });
      if (pageParam) params.set("cursor", pageParam);
      const path = `/issues/${issueId}/decision-receipts?${params}`;
      // React Query deduplicates by viewer; never join an older account's
      // URL-only HTTP request after its session has changed.
      detachInflightGet(path);
      return api.get<DecisionHistoryPage>(path, { signal, cache: "no-store" });
    },
    getNextPageParam: page => page.nextCursor,
    retry: false,
  });
  const accessUnavailable = !!query.error && "status" in query.error && [401, 403, 404].includes(Number(query.error.status));
  const receipts = useMemo(() => {
    if (!enabled || !conversationMode || accessUnavailable) return [];
    // Overlapping pages after a live invalidation represent the same event.
    return [...new Map((query.data?.pages ?? []).flatMap(page => page.items).map(item => [item.id, item])).values()];
  }, [enabled, conversationMode, query.data, accessUnavailable]);
  return { ...query, receipts, enabled: enabled && conversationMode === true };
}

export function CoordinatorChatDecisionReceipt({ receipt }: { receipt: DecisionHistoryItem }) {
  const Icon = receipt.outcome === "answered" ? MessageSquare : receipt.outcome === "changes_requested" ? RotateCcw : receipt.outcome === "rejected" ? X : Check;
  return <Link to={receipt.href} className="coordinator-decision-receipt" data-testid="coordinator-chat-decision-receipt">
    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{receipt.label}</span>
      <span className="block truncate text-xs text-muted-foreground"><span className="font-mono">{receipt.issueIdentifier ?? receipt.issueId}</span> · {receipt.title}</span>
    </span>
    <CoordinatorRelativeTime value={receipt.resolvedAt} className="shrink-0 text-xs text-muted-foreground" />
    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  </Link>;
}

export function CoordinatorChatReceiptStatus({ query }: { query: ReturnType<typeof useCoordinatorChatDecisionReceipts> }) {
  if (!query.enabled) return null;
  if (query.isError) return <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>Decision updates couldn’t load.</span><Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button>
  </div>;
  if (query.hasNextPage) return <Button size="sm" variant="ghost" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
    {query.isFetchingNextPage ? "Loading earlier decisions…" : "Load earlier decisions"}
  </Button>;
  return null;
}
