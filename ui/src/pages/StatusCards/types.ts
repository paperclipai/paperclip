import type { StatusCard, StatusCardUpdate } from "@paperclipai/shared";

/**
 * Board/drawer view of a status card.
 *
 * The live P1 API (PAP-15078) returns the base {@link StatusCard} row. The
 * optional enrichment fields below are produced by the P2/P4 compile + update
 * flows (summary document body, matched-issue count, per-day token rollups).
 * Until those land they are `undefined`, and the UI renders the matching
 * compiling / empty affordance rather than blanking — stale and error cards
 * always keep their last good summary (plan §7).
 */
export interface StatusCardView extends StatusCard {
  /** Latest summary markdown (from the card's summary document). */
  summaryBody?: string | null;
  /** Number of issues currently matched by the compiled query. */
  watchedIssueCount?: number | null;
  /** Tokens spent by this card so far today. */
  todayTokens?: number | null;
  /** Cost in cents spent by this card so far today. */
  todayCostCents?: number | null;
}

export type { StatusCard, StatusCardUpdate };
