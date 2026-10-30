import { useMemo, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ConversationTaskHandoff, ConversationTaskHandoffPage, IssueThreadInteraction } from "@paperclipai/shared";
import { api, detachInflightGet } from "@/api/client";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { Button } from "@/components/ui/button";
import { CoordinatorCreatedTaskLink, CoordinatorTaskMotion } from "./CoordinatorTaskCommitment";

/** Bounded, viewer-scoped source-chat projection, shared by chat and its Tasks tab. */
export function useCoordinatorChatTaskHandoffs(issueId: string | null, conversationMode = true) {
  const { enabled, userId } = useCoordinatorWorkspaceEnabled();
  const query = useInfiniteQuery({
    queryKey: ["issues", "chat-handoffs", issueId, userId],
    enabled: enabled && !!issueId && !!userId && conversationMode,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: "100" });
      if (pageParam) params.set("cursor", pageParam);
      const path = `/issues/${issueId}/chat-handoffs?${params}`;
      // React Query deduplicates by viewer; never join an older account's
      // URL-only HTTP request after its session has changed.
      detachInflightGet(path);
      return api.get<ConversationTaskHandoffPage>(path, { signal, cache: "no-store" });
    },
    getNextPageParam: page => page.nextCursor,
    retry: false,
  });
  const accessUnavailable = !!query.error && "status" in query.error && [401, 403, 404].includes(Number(query.error.status));
  const handoffs = useMemo(() => {
    if (!enabled || !conversationMode || accessUnavailable) return [];
    return [...new Map((query.data?.pages ?? []).flatMap(page => page.items).map(item => [item.id, item])).values()];
  }, [enabled, conversationMode, query.data, accessUnavailable]);
  return { ...query, handoffs, enabled: enabled && conversationMode };
}

export function standaloneChatHandoffs(handoffs: ConversationTaskHandoff[], interactions: IssueThreadInteraction[]) {
  const renderedSuggestions = new Set(interactions.filter(item => item.kind === "suggest_tasks" && item.status === "accepted").map(item => item.id));
  return handoffs.filter(item => !item.suggestionInteractionId || !renderedSuggestions.has(item.suggestionInteractionId));
}

/** First load and loading older pages are historical, not new task events. */
export function useLiveChatHandoffIds(scope: string, handoffs: ConversationTaskHandoff[], fetched: boolean) {
  const observed = useRef<{ scope: string; initialized: boolean; ids: Set<string>; live: Set<string>; newest: number }>({ scope, initialized: false, ids: new Set(), live: new Set(), newest: 0 });
  return useMemo(() => {
    if (observed.current.scope !== scope) observed.current = { scope, initialized: false, ids: new Set(), live: new Set(), newest: 0 };
    const state = observed.current;
    if (!fetched) return state.live;
    for (const handoff of handoffs) {
      if (state.initialized && !state.ids.has(handoff.id) && new Date(handoff.createdAt).getTime() > state.newest) state.live.add(handoff.id);
      state.ids.add(handoff.id);
    }
    state.newest = Math.max(state.newest, ...handoffs.map(item => new Date(item.createdAt).getTime()));
    state.initialized = true;
    return new Set(state.live);
  }, [scope, handoffs, fetched]);
}

export function CoordinatorChatTaskHandoff({ handoff, animateEntry = false }: { handoff: ConversationTaskHandoff; animateEntry?: boolean }) {
  return <CoordinatorTaskMotion eventId={handoff.id} phase="created" createdAt={handoff.createdAt} animateCreatedEntry={animateEntry}>
    <CoordinatorCreatedTaskLink task={handoff} createdAt={handoff.createdAt} />
  </CoordinatorTaskMotion>;
}

export function CoordinatorChatHandoffStatus({ query }: { query: ReturnType<typeof useCoordinatorChatTaskHandoffs> }) {
  if (!query.enabled) return null;
  if (query.isError) return <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <span>Created tasks couldn’t load.</span><Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button>
  </div>;
  if (query.hasNextPage) return <Button size="sm" variant="ghost" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
    {query.isFetchingNextPage ? "Loading earlier tasks…" : "Load earlier tasks"}
  </Button>;
  return null;
}
