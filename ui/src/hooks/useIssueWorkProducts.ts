import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";

/** Saved rows stay authoritative while GitHub enriches matching PR versions. */
export function useIssueWorkProducts(issueId: string | null | undefined) {
  const stored = useQuery({
    queryKey: queryKeys.issues.workProducts(issueId ?? "__none__"),
    queryFn: ({ signal }) => issuesApi.listWorkProducts(issueId!, { signal, fresh: true }),
    enabled: Boolean(issueId),
    refetchOnMount: "always",
    placeholderData: keepPreviousDataForSameQueryTail<IssueWorkProduct[]>(issueId ?? "__none__"),
  });
  const pullRequests = stored.data?.filter((product) => product.type === "pull_request") ?? [];
  const hasPullRequests = Boolean(issueId) && pullRequests.length > 0;
  const provider = useQuery({
    // A saved PR change gets its own refresh; adding an artifact does not restart GitHub.
    queryKey: [...queryKeys.issues.workProductPullRequestRefresh(issueId ?? "__none__"), pullRequests],
    queryFn: ({ signal }) => issuesApi.listWorkProducts(issueId!, { refreshPullRequests: true, signal, fresh: true }),
    enabled: hasPullRequests,
    refetchOnMount: "always",
  });
  const data = useMemo(() => {
    const refreshed = new Map(provider.data?.map((product) => [product.id, product]));
    return stored.data?.map((product) => {
      const enriched = refreshed.get(product.id);
      if (product.type !== "pull_request" || !enriched
        || new Date(enriched.updatedAt).getTime() !== new Date(product.updatedAt).getTime()) return product;
      // Never replace the saved list, its review flags, or its links with a provider snapshot.
      return { ...product, metadata: enriched.metadata };
    });
  }, [stored.data, provider.data]);
  return {
    ...stored,
    data,
    isFetching: stored.isFetching || provider.isFetching,
    isError: stored.isError || provider.isError,
    error: stored.error ?? provider.error,
    refetch: async () => {
      await Promise.all([stored.refetch(), ...(hasPullRequests ? [provider.refetch()] : [])]);
    },
  };
}
