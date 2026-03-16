import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";

interface FavoriteButtonProps {
  issueId: string;
  companyId: string;
  /** Size of the button */
  size?: "sm" | "xs";
  className?: string;
}

/**
 * Button to toggle favorite status on an issue.
 * Uses optimistic updates for immediate feedback.
 */
export function FavoriteButton({
  issueId,
  companyId,
  size = "sm",
  className,
}: FavoriteButtonProps) {
  const queryClient = useQueryClient();

  // Fetch all favorite IDs to determine current state
  const { data: favoriteData } = useQuery({
    queryKey: queryKeys.issues.favoriteIds(companyId),
    queryFn: () => issuesApi.getFavoriteIds(companyId),
    enabled: !!companyId,
  });

  const favoriteIds = new Set(favoriteData?.ids ?? []);
  const isFavorited = favoriteIds.has(issueId);

  // Add favorite mutation with optimistic update
  const addFavorite = useMutation({
    mutationFn: () => issuesApi.addFavorite(issueId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.favoriteIds(companyId) });
      const previousData = queryClient.getQueryData(queryKeys.issues.favoriteIds(companyId));

      // Optimistically add the issueId
      queryClient.setQueryData(
        queryKeys.issues.favoriteIds(companyId),
        (old: { ids: string[] } | undefined) => ({
          ids: [...(old?.ids ?? []), issueId],
        }),
      );

      return { previousData };
    },
    onError: (_err, _vars, context) => {
      // Rollback on error
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.issues.favoriteIds(companyId), context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.favoriteIds(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.favorites(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    },
  });

  // Remove favorite mutation with optimistic update
  const removeFavorite = useMutation({
    mutationFn: () => issuesApi.removeFavorite(issueId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.issues.favoriteIds(companyId) });
      const previousData = queryClient.getQueryData(queryKeys.issues.favoriteIds(companyId));

      // Optimistically remove the issueId
      queryClient.setQueryData(
        queryKeys.issues.favoriteIds(companyId),
        (old: { ids: string[] } | undefined) => ({
          ids: (old?.ids ?? []).filter((id) => id !== issueId),
        }),
      );

      return { previousData };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKeys.issues.favoriteIds(companyId), context.previousData);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.favoriteIds(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.favorites(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    },
  });

  const isPending = addFavorite.isPending || removeFavorite.isPending;

  const handleClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (isPending) return;

    if (isFavorited) {
      removeFavorite.mutate();
    } else {
      addFavorite.mutate();
    }
  };

  const buttonSize = size === "xs" ? "icon-xs" : "icon-sm";

  return (
    <Button
      variant="ghost"
      size={buttonSize}
      onClick={handleClick}
      disabled={isPending}
      className={cn(
        "shrink-0 transition-colors",
        isFavorited && "text-yellow-500 hover:text-yellow-600",
        className,
      )}
      title={isFavorited ? "Remove from favorites" : "Add to favorites"}
    >
      <Star
        className={cn(
          "h-4 w-4 transition-all",
          isFavorited && "fill-current",
        )}
      />
    </Button>
  );
}
