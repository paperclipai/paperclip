import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

type FavoritesResponse = { issueIds: string[] };

/**
 * Per-user issue favorites for a company. Backed by
 * GET/POST/DELETE /companies/:id/favorites + /issues/:id/favorite.
 * Toggling is optimistic so the star reflects intent immediately.
 */
export function useIssueFavorites(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = companyId
    ? queryKeys.issues.favorites(companyId)
    : (["issues", "__disabled__", "favorites"] as const);

  const { data } = useQuery({
    queryKey,
    queryFn: () => issuesApi.listFavorites(companyId!),
    enabled: !!companyId,
  });

  const favoriteIds = useMemo(
    () => new Set<string>(data?.issueIds ?? []),
    [data],
  );

  const toggleMutation = useMutation<
    { issueId: string; favorite: boolean },
    unknown,
    { issueId: string; favorite: boolean },
    { previous: FavoritesResponse | undefined }
  >({
    mutationFn: async ({ issueId, favorite }) => {
      if (favorite) await issuesApi.addFavorite(issueId);
      else await issuesApi.removeFavorite(issueId);
      return { issueId, favorite };
    },
    onMutate: async ({ issueId, favorite }) => {
      if (!companyId) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FavoritesResponse>(queryKey);
      const current = new Set(previous?.issueIds ?? []);
      if (favorite) current.add(issueId);
      else current.delete(issueId);
      queryClient.setQueryData<FavoritesResponse>(queryKey, { issueIds: [...current] });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (!context || context.previous === undefined) return;
      queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      if (!companyId) return;
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const isFavorite = useCallback((issueId: string) => favoriteIds.has(issueId), [favoriteIds]);

  const toggleFavorite = useCallback(
    (issueId: string) => {
      if (!companyId) return;
      toggleMutation.mutate({ issueId, favorite: !favoriteIds.has(issueId) });
    },
    [companyId, favoriteIds, toggleMutation],
  );

  return {
    favoriteIds,
    isFavorite,
    toggleFavorite,
    enabled: !!companyId,
    isPending: toggleMutation.isPending,
  };
}
