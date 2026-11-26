import type { ResponsibilitySummary } from "@paperclipai/shared";
import { timeAgo } from "./timeAgo";

/**
 * The written paragraphs on the Dashboard and the responsibility page
 * (experimental, `enableResponsibilities`): when to read them again while a
 * model-written version is being made, and how to say who wrote them.
 */

/**
 * Waits between reads while the server says a model-written version is on
 * its way: quick at first, then slower, then stop (about 45 seconds in all).
 */
export const SUMMARY_REFRESH_DELAYS_MS: readonly number[] = [2_000, 3_000, 5_000, 8_000, 12_000, 15_000];

/**
 * When to read the paragraph again: while `refreshing`, after the next wait
 * in `SUMMARY_REFRESH_DELAYS_MS` (the nth successful read waits the nth
 * delay); never once it is not refreshing, there is no paragraph, or the
 * waits are used up.
 */
export function summaryRefetchDelay(
  data: Pick<ResponsibilitySummary, "refreshing"> | undefined,
  successfulReads: number,
): number | false {
  if (!data?.refreshing) return false;
  return SUMMARY_REFRESH_DELAYS_MS[Math.max(0, successfulReads - 1)] ?? false;
}

export interface SummaryAttribution {
  /** "Written by AI" or "Summarized from the numbers": never AI for a computed paragraph. */
  source: string;
  /** "5m ago". */
  when: string;
  /** Shown only while the AI version is still expected. */
  pending: string | null;
}

/** Who wrote the paragraph and when, honestly. `stillWaiting`: the page is still reading it again. */
export function summaryAttribution(
  summary: Pick<ResponsibilitySummary, "source" | "generatedAt" | "refreshing">,
  stillWaiting: boolean,
): SummaryAttribution {
  return {
    source: summary.source === "model" ? "Written by AI" : "Summarized from the numbers",
    when: timeAgo(summary.generatedAt),
    pending: summary.refreshing && stillWaiting && summary.source !== "model" ? "AI summary on the way" : null,
  };
}
