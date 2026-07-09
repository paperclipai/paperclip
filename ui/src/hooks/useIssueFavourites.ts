import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueFavourite } from "@paperclipai/shared";
import { issueFavouritesApi } from "../api/issueFavourites";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * Per-user favourite tasks for the selected company. Backed by
 * `/companies/:companyId/issue-favourites`, this exposes joined favourite issue
 * records plus a toggle so the star stays in sync across task surfaces.
 */
export function useIssueFavourites(companyIdOverride?: string | null) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdOverride ?? selectedCompanyId ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const query = useQuery({
    queryKey: queryKeys.issueFavourites.list(companyId!),
    queryFn: () => issueFavouritesApi.list(companyId!),
    enabled: !!companyId,
  });

  const favourites = query.data;
  const favouriteIds = useMemo(
    () => new Set((favourites ?? []).map((f: IssueFavourite) => f.issueId)),
    [favourites],
  );

  const mutation = useMutation({
    mutationFn: async ({ issueId, favourite }: { issueId: string; favourite: boolean }) => {
      if (!companyId) throw new Error("No company selected");
      if (favourite) {
        await issueFavouritesApi.add(companyId, issueId);
      } else {
        await issueFavouritesApi.remove(companyId, issueId);
      }
    },
    onSuccess: () => {
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issueFavourites.list(companyId) });
      }
    },
    onError: (error) => {
      pushToast({
        title: "Couldn't update favourite",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  const isFavourite = useCallback((issueId: string) => favouriteIds.has(issueId), [favouriteIds]);

  const toggle = useCallback(
    (issueId: string) => {
      if (!companyId) return;
      mutation.mutate({ issueId, favourite: !favouriteIds.has(issueId) });
    },
    [companyId, favouriteIds, mutation],
  );

  return {
    favourites: favourites ?? [],
    favouriteIds,
    isFavourite,
    toggle,
    isLoading: query.isLoading,
    isToggling: mutation.isPending,
  };
}
