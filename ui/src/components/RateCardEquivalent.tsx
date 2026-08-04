import { cn, formatCents } from "@/lib/utils";

/**
 * Subscription-included runs bill against a plan rather than per token, so their
 * metered cost is a genuine $0. Rendering only that zero makes the heaviest token
 * consumers look free and sorts them cheapest, which is the opposite of the truth.
 *
 * This renders the list-price equivalent next to the cash figure, always labelled
 * "rate card" so it is never mistaken for an amount owed. It is the right number
 * for comparing agents against each other and for spotting a runaway; it is the
 * wrong number for an invoice.
 */

const EXPLAINER =
  "Rate-card equivalent: what these subscription-included runs would have cost at list price. " +
  "They bill against a plan, not per token, so no cash was metered for them.";

interface RateCardEquivalentProps {
  /** list-price value of subscription-included usage, in cents */
  cents: number;
  className?: string;
}

/** Inline "+ $X rate card" tag. Renders nothing when there is no subscription usage. */
export function RateCardEquivalent({ cents, className }: RateCardEquivalentProps) {
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return (
    <span
      className={cn("font-normal text-muted-foreground whitespace-nowrap", className)}
      title={EXPLAINER}
    >
      + {formatCents(cents)} rate card
    </span>
  );
}
