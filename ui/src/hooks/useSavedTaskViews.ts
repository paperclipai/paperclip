import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SavedTaskView } from "@paperclipai/shared";
import { authApi } from "../api/auth";
import { savedTaskViewsApi } from "../api/savedTaskViews";
import { queryKeys } from "../lib/queryKeys";
import {
  missingStarterTaskViews,
  STARTER_SAVED_TASK_VIEWS,
  toSavedViewDefinition,
} from "../lib/saved-task-views";

/**
 * The signed-in user's saved views for one task collection.
 *
 * Server-held, not browser-held: a view saved on a phone has to be there on a
 * laptop, and has to survive clearing site data. There is no local mirror —
 * one copy means there is nothing to reconcile when two devices disagree.
 */
export function useSavedTaskViews(companyId: string | null | undefined, collectionKey: string) {
  const queryClient = useQueryClient();
  // Who is signed in is part of the cache key, and the list is not fetched
  // until that is known. A session can end and another person can sign in
  // without the page ever reloading; without the user in the key, the first
  // person's view names and search text would be served to the second.
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  const queryKey = queryKeys.savedTaskViews.list(
    companyId ?? "__none__",
    userId ?? "__anon__",
    collectionKey,
  );

  const query = useQuery({
    queryKey,
    queryFn: () => savedTaskViewsApi.list(companyId!, collectionKey),
    enabled: !!companyId && !!userId,
    // Views change only when this user changes them, so the list is refreshed
    // by the mutations below rather than by polling.
    staleTime: 60_000,
  });

  // Returned, not fired and forgotten: React Query waits on the promise an
  // `onSuccess` returns, so `mutateAsync` only resolves once the list holds the
  // new view. A caller that navigates to a view it has just created would
  // otherwise arrive before the list knows the view exists and be sent back to
  // All tasks.
  const invalidate = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey });
    // queryKey is derived from these three values, so listing them is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, companyId, userId, collectionKey]);

  const create = useMutation({
    mutationFn: (input: { name: string; viewState: Record<string, unknown> }) =>
      savedTaskViewsApi.create(companyId!, {
        collectionKey,
        name: input.name,
        viewState: toSavedViewDefinition(input.viewState),
      }),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: (input: {
      id: string;
      name?: string;
      viewState?: Record<string, unknown>;
      position?: number;
    }) =>
      savedTaskViewsApi.update(companyId!, input.id, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.viewState === undefined
          ? {}
          : { viewState: toSavedViewDefinition(input.viewState) }),
        ...(input.position === undefined ? {} : { position: input.position }),
      }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => savedTaskViewsApi.remove(companyId!, id),
    onSuccess: invalidate,
  });

  const addStarterViews = useMutation({
    mutationFn: async () => {
      // Sequential, so `position` comes out in the listed order.
      //
      // Resumable: a starter whose name is already present is skipped rather
      // than retried into a name clash. So a run that fails half way — the
      // network drops after three of seven — leaves three real views behind,
      // and pressing the button again creates only the four that are missing.
      const existing = await savedTaskViewsApi.list(companyId!, collectionKey);
      const missing = new Set(missingStarterTaskViews(existing));
      const created: SavedTaskView[] = [];
      for (const [index, starter] of STARTER_SAVED_TASK_VIEWS.entries()) {
        if (!missing.has(starter)) continue;
        created.push(
          await savedTaskViewsApi.create(companyId!, {
            collectionKey,
            name: starter.name,
            viewState: toSavedViewDefinition(starter.definition),
            position: index,
          }),
        );
      }
      return created;
    },
    // `onSettled`, not `onSuccess`: a partial run still created views, and the
    // menu has to show them so the user can see what they got.
    onSettled: invalidate,
  });

  const views = useMemo(() => query.data ?? [], [query.data]);

  return {
    views,
    isLoading: query.isLoading,
    /**
     * True while the list may still gain a view — the first load, or a refresh
     * after a mutation. A surface asked to open `saved:<id>` must not decide
     * the id is unknown until this is false.
     */
    isResolving: (!!companyId && !userId) || query.isLoading || query.isFetching,
    /**
     * Saved views need a signed-in board user. With none (an agent token, a
     * company or session still loading) the menu shows built-in views only
     * rather than failing the page.
     */
    isAvailable: !!companyId && !!userId && !query.isError,
    error: query.error as Error | null,
    create,
    update,
    remove,
    addStarterViews,
  };
}

export type UseSavedTaskViewsResult = ReturnType<typeof useSavedTaskViews>;
