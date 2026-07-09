import { Star } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { useIssueFavourites } from "../hooks/useIssueFavourites";

type FavouriteButtonProps = {
  issueId: string;
  className?: string;
};

/**
 * Star toggle that favourites/unfavourites a task for the current user. Reads
 * and mutates the shared favourites list via {@link useIssueFavourites}, so it
 * stays in sync with the sidebar Favourites section and the Favourites page.
 */
export function FavouriteButton({ issueId, className }: FavouriteButtonProps) {
  const { isFavourite, toggle, isToggling } = useIssueFavourites();
  const favourited = isFavourite(issueId);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    toggle(issueId);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn("shrink-0", className)}
      aria-pressed={favourited}
      aria-label={favourited ? "Remove from favourites" : "Add to favourites"}
      title={favourited ? "Remove from favourites" : "Add to favourites"}
      disabled={isToggling}
      onClick={handleClick}
    >
      <Star
        className={cn(
          "h-4 w-4 transition-colors",
          favourited ? "fill-amber-400 text-amber-400" : "text-muted-foreground",
        )}
      />
    </Button>
  );
}
