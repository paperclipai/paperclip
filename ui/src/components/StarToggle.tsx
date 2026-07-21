import type { MouseEvent } from "react";
import { Loader2, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

export interface StarToggleProps {
  /** Whether the resource is currently starred (post-optimistic value). */
  starred: boolean;
  /** Human-readable resource name, used for the accessible label. */
  resourceName: string;
  /** Optimistic mutation in flight — shows a spinner and blocks input. */
  pending?: boolean;
  /** Last mutation failed — surface a retry affordance (red star). */
  error?: boolean;
  /**
   * "row" — quiet icon-only control for sidebar and browse-list rows.
   * "button" — always-visible icon-only control for detail headers.
   */
  size?: "row" | "button";
  /** Called with the desired next starred value. */
  onToggle: (nextStarred: boolean) => void;
  /**
   * Row variant only: keep the control hidden at rest even when starred, so it
   * only appears on hover/focus. Sidebar rows are "intentionally quiet"; browse
   * rows keep the starred control visible.
   */
  quiet?: boolean;
  /** Extra classes for the control itself. */
  className?: string;
  /**
   * Row variant only: classes that control at-rest visibility when the resource
   * is not starred (e.g. reveal on hover/focus). Ignored when starred (a starred
   * control is always visible) or on the button variant. Defaults to the shared
   * unnamed-`group` reveal used by browse rows; sidebar passes a named-group
   * variant so it reveals with `group/project` / `group/agent`.
   */
  revealClassName?: string;
}

const DEFAULT_ROW_REVEAL =
  "opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100";

export function StarToggle({
  starred,
  resourceName,
  pending = false,
  error = false,
  size = "row",
  onToggle,
  quiet = false,
  className,
  revealClassName,
}: StarToggleProps) {
  const ariaLabel = starred ? `Unstar ${resourceName}` : `Star ${resourceName}`;
  const Icon = pending ? Loader2 : Star;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    // On error, retry the last intent (toggle toward the desired end state).
    onToggle(!starred);
  }

  if (size === "button") {
    return (
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={ariaLabel}
        aria-pressed={starred}
        aria-busy={pending ? "true" : undefined}
        disabled={pending}
        onClick={handleClick}
        title={error ? "Couldn't save — retry" : undefined}
        className={cn(
          error
            ? "text-red-500 hover:text-red-500"
            : starred
              ? "text-amber-600 dark:text-amber-500"
              : undefined,
          className,
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4",
            pending && "motion-safe:animate-spin",
            !pending && starred && !error && "fill-amber-500 text-amber-500",
            !pending && error && "text-red-500",
          )}
        />
      </Button>
    );
  }

  // Row variant: a starred (or errored) control is always visible; an unstarred
  // one is quiet and revealed on hover/focus so the nav stays calm. When `quiet`
  // (sidebar), even a starred control hides at rest and reveals on hover/focus.
  const visible = error || pending || (starred && !quiet);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={ariaLabel}
      aria-pressed={starred}
      aria-busy={pending ? "true" : undefined}
      disabled={pending}
      onClick={handleClick}
      title={error ? "Couldn't save — retry" : undefined}
      className={cn(
        "h-6 w-6 shrink-0",
        visible ? "opacity-100" : revealClassName ?? DEFAULT_ROW_REVEAL,
        className,
      )}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5",
          pending && "motion-safe:animate-spin",
          !pending && error && "text-red-500",
          !pending && !error && starred && "fill-amber-500 text-amber-500",
          !pending && !error && !starred && "text-muted-foreground",
        )}
      />
    </Button>
  );
}
