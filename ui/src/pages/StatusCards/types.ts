import type { StatusCard, StatusCardUpdate } from "@paperclipai/shared";

/**
 * Board/drawer view of a status card.
 *
 * The API returns the base {@link StatusCard} row plus the optional enrichment
 * fields below, hydrated from the compile + update pipelines (summary document
 * body, matched-issue count, per-day token rollups). A field is `undefined`
 * when its source has not produced data yet (e.g. before the first compile),
 * and the UI renders the matching compiling / empty affordance rather than
 * blanking — stale and error cards always keep their last good summary
 * (plan §7).
 */
export interface StatusCardView extends StatusCard {
  /** Latest summary markdown (from the card's summary document). */
  summaryBody?: string | null;
  /** Watched-issue count: compiled-query matches plus summary mentions. */
  watchedIssueCount?: number;
  /** Tokens spent by this card so far today. */
  todayTokens?: number;
  /** Cost in cents spent by this card so far today. */
  todayCostCents?: number;
}

export type { StatusCard, StatusCardUpdate };
