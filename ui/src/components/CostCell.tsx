import { cn, formatCents } from "../lib/utils";

export type CostCellProps = {
  cents: number | null | undefined;
  /** Text to render when `cents` is null or undefined. Defaults to "unpriced". */
  unpricedFallback?: string;
  /**
   * Text to render when `cents === 0`. Defaults to `"$0.00"` so a genuine free
   * row renders identically to a normal priced row. Callers that want to draw
   * extra attention to free runs (e.g. "free") should opt in explicitly.
   */
  freeFallback?: string;
  className?: string;
};

/**
 * Tri-state cost renderer for cents values:
 * - `null`/`undefined`  → muted "unpriced" text with an a11y label.
 * - `0`                 → renders the same as any priced row by default.
 * - `> 0`               → standard `formatCents` output.
 *
 * This is the single primitive surface lanes (E1–E4) reach for so they don't
 * have to redo null guards at every cost render site.
 */
export function CostCell({ cents, unpricedFallback = "unpriced", freeFallback, className }: CostCellProps) {
  if (cents == null) {
    return (
      <span
        className={cn("text-muted-foreground", className)}
        aria-label="cost not available"
      >
        {unpricedFallback}
      </span>
    );
  }
  if (cents === 0) {
    return <span className={className}>{freeFallback ?? formatCents(0)}</span>;
  }
  return <span className={className}>{formatCents(cents)}</span>;
}
