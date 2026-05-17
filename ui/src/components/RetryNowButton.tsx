import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { useRetryNowMutation } from "../hooks/useRetryNowMutation";

interface RetryNowButtonProps {
  issueId: string | null | undefined;
  className?: string;
  /** "compact" — small chip-style for inline placement next to badges. "default" — full button. */
  variant?: "compact" | "default";
}

/**
 * Promotes a scheduled retry immediately. Used wherever a "Retry scheduled"
 * badge is shown but the user might want to force the retry to run now
 * instead of waiting for the backoff to elapse.
 */
export function RetryNowButton({ issueId, className, variant = "compact" }: RetryNowButtonProps) {
  const retryNow = useRetryNowMutation(issueId);
  if (!issueId) return null;

  const isSuccessTransient = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");
  const disabled = retryNow.isPending || isSuccessTransient;

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          retryNow.mutate();
        }}
        disabled={disabled}
        data-testid="retry-now-chip"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[11px] font-medium text-cyan-700 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-cyan-300",
          className,
        )}
      >
        {retryNow.isPending ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Retrying…
          </>
        ) : isSuccessTransient ? (
          <>
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Promoted
          </>
        ) : (
          <>
            <RotateCcw className="h-3 w-3" aria-hidden />
            Retry now
          </>
        )}
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("shrink-0 shadow-none", className)}
      onClick={() => retryNow.mutate()}
      disabled={disabled}
      data-testid="retry-now-button"
    >
      {retryNow.isPending ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Retrying…
        </span>
      ) : isSuccessTransient ? (
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          Promoted
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Retry now
        </span>
      )}
    </Button>
  );
}
