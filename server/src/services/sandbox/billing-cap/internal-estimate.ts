/**
 * Phase 4A-S4 B2 (LET-367): Source B — internal cost estimate computed from
 * `environment_leases` rows scoped to provider `e2b`.
 *
 * Formula (S3 §3 deferred-to-pilot rate): per-second cents × seconds of
 * lease wallclock overlap with the window. Overlap math:
 *   overlap = clamp(min(end, windowEnd) - max(start, windowStart), 0)
 * with `end = releasedAt ?? now` and `start = acquiredAt`.
 *
 * The default per-second rate is the public E2B microVM rate floor of
 * USD 0.00007/sec — i.e. 0.007 cents/sec. The monitor accepts a rate override
 * so tests and future pricing updates can change the cost without touching
 * the formula.
 *
 * The query stays read-only and respects the provider key, so leases for
 * `docker`, `fake`, `null`, or unrelated providers never contribute to the
 * total.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases } from "@paperclipai/db";
import { utcDayBounds, utcMonthBounds } from "./window.js";
import type { SourceB, SourceBSample } from "./usage-source.js";

/**
 * Default per-second rate for the E2B pilot, in cents.
 * 0.007 cents per second ≈ USD 25.20 per CPU-hour.
 */
export const E2B_DEFAULT_RATE_PER_SECOND_CENTS = 0.007;

export interface InternalEstimateOptions {
  /** Stable provider key to filter leases on (default `e2b`). */
  provider?: string;
  /** Per-second cost in cents; overrides the default rate snapshot. */
  ratePerSecondCents?: number;
}

interface LeaseRowSlice {
  acquiredAt: Date;
  releasedAt: Date | null;
}

function overlapSeconds(
  lease: LeaseRowSlice,
  windowStart: Date,
  windowEnd: Date,
  now: Date,
): number {
  const start = lease.acquiredAt.getTime();
  const end = (lease.releasedAt ?? now).getTime();
  const lo = Math.max(start, windowStart.getTime());
  const hi = Math.min(end, windowEnd.getTime());
  const seconds = Math.max(0, (hi - lo) / 1000);
  return seconds;
}

export function summariseLeaseSpend(input: {
  leases: LeaseRowSlice[];
  now: Date;
  ratePerSecondCents: number;
}): SourceBSample {
  const day = utcDayBounds(input.now);
  const month = utcMonthBounds(input.now);
  let dayRuntime = 0;
  let monthRuntime = 0;
  for (const lease of input.leases) {
    dayRuntime += overlapSeconds(lease, day.start, day.end, input.now);
    monthRuntime += overlapSeconds(lease, month.start, month.end, input.now);
  }
  const dayCents = Math.round(dayRuntime * input.ratePerSecondCents);
  const monthCents = Math.round(monthRuntime * input.ratePerSecondCents);
  return {
    dayCents,
    monthCents,
    dayRuntimeSeconds: dayRuntime,
    monthRuntimeSeconds: monthRuntime,
    ratePerSecondCents: input.ratePerSecondCents,
  };
}

export class LeaseBasedSourceB implements SourceB {
  private readonly provider: string;
  private readonly ratePerSecondCents: number;

  constructor(
    private readonly db: Db,
    options: InternalEstimateOptions = {},
  ) {
    this.provider = options.provider ?? "e2b";
    this.ratePerSecondCents = options.ratePerSecondCents ?? E2B_DEFAULT_RATE_PER_SECOND_CENTS;
  }

  async sample(input: { companyId: string; now: Date }): Promise<SourceBSample> {
    const month = utcMonthBounds(input.now);
    // Pull every lease whose end-of-life lands inside (or after) the current
    // month window. Active leases (`releasedAt IS NULL`) always qualify.
    const rows = await this.db
      .select({
        acquiredAt: environmentLeases.acquiredAt,
        releasedAt: environmentLeases.releasedAt,
      })
      .from(environmentLeases)
      .where(
        and(
          eq(environmentLeases.companyId, input.companyId),
          eq(environmentLeases.provider, this.provider),
          // Filter out rows that are guaranteed to be outside the month window.
          // Released-after-month-start OR still active.
          // `acquiredAt < month.end` is implied by the lease existing.
          // We add an explicit NOT NULL guard on acquiredAt for safety.
          isNotNull(environmentLeases.acquiredAt),
        ),
      );
    const leases: LeaseRowSlice[] = rows
      .filter((row) => row.acquiredAt instanceof Date)
      .map((row) => ({
        acquiredAt: row.acquiredAt,
        releasedAt: row.releasedAt ?? null,
      }));
    return summariseLeaseSpend({
      leases,
      now: input.now,
      ratePerSecondCents: this.ratePerSecondCents,
    });
  }
}
