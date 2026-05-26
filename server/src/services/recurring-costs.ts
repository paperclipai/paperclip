/**
 * Recurring fixed cost tick — inserts one cost_event per active recurring line per
 * company per UTC month, idempotently.
 *
 * Wired in app.ts alongside feedbackExportTimer (same shape). Hourly tick is fine:
 * the KPI cadence is weekly (Friday pack), so an insert that lands within the first
 * hour of UTC day 1 is plenty of precision.
 *
 * Architecture: PAR-304 plan rev 2.
 */

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, costEvents } from "@paperclipai/db";
import type { RecurringCostLine } from "@paperclipai/shared";
import type { Logger } from "pino";

export const RECURRING_FIXED_BILLING_TYPE = "recurring_fixed";

/** Statuses that count an agent as "active" for ceo-fallback attribution. Mirrors budgets.ts. */
const CEO_FALLBACK_ACTIVE_STATUSES = ["active", "idle", "running", "error"];

/** [monthStart, monthEnd) for the UTC month containing `now`. */
function currentUtcMonthWindow(now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

/** ISO date "YYYY-MM-DD" for the UTC date inside `d`. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Returns true if `line` is active during the UTC month starting at `monthStart`. */
function isLineActiveInMonth(line: RecurringCostLine, monthStart: Date, today: Date): boolean {
  const todayIso = toIsoDate(today);
  if (line.startedOn > todayIso) return false;
  if (line.endedOn !== null) {
    const monthStartIso = toIsoDate(monthStart);
    if (line.endedOn < monthStartIso) return false;
  }
  return true;
}

export interface RecurringCostsServiceOptions {
  db: Db;
  logger: Logger;
  /** Override the clock for tests. */
  now?: () => Date;
}

export interface RecurringCostsService {
  /** Run one tick. Returns the per-company insert / skip counts. */
  tick: () => Promise<{ inserted: number; skipped: number; companies: number }>;
  /**
   * Run an immediate tick and schedule an hourly tick thereafter. The returned timer is
   * .unref()'d so it does not keep the process alive in tests. Returns a stop() that
   * clears the interval.
   */
  start: () => () => void;
}

export function createRecurringCostsService(opts: RecurringCostsServiceOptions): RecurringCostsService {
  const { db, logger } = opts;
  const now = opts.now ?? (() => new Date());

  async function resolveAttributionAgentId(
    companyId: string,
    explicit: string | null,
  ): Promise<string | null> {
    if (explicit) return explicit;
    const fallback = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.role, "ceo"),
          inArray(agents.status, CEO_FALLBACK_ACTIVE_STATUSES),
        ),
      )
      .orderBy(agents.createdAt)
      .limit(1)
      .then((rows) => rows[0]?.id ?? null);
    return fallback;
  }

  async function tickOnce() {
    const ref = now();
    const { start: monthStart, end: monthEnd } = currentUtcMonthWindow(ref);
    const result = { inserted: 0, skipped: 0, companies: 0 };

    const rows = await db
      .select({
        id: companies.id,
        recurringCosts: companies.recurringCosts,
        costAttributionAgentId: companies.costAttributionAgentId,
      })
      .from(companies)
      .where(sql`jsonb_array_length(${companies.recurringCosts}) > 0`);

    for (const row of rows) {
      const lines = (row.recurringCosts ?? []) as RecurringCostLine[];
      if (lines.length === 0) continue;
      result.companies += 1;

      const attributionAgentId = await resolveAttributionAgentId(row.id, row.costAttributionAgentId);
      if (!attributionAgentId) {
        logger.warn(
          { companyId: row.id },
          "recurring-costs: no attribution agent (no ceo agent and no override); skipping company",
        );
        continue;
      }

      for (const line of lines) {
        if (!isLineActiveInMonth(line, monthStart, ref)) {
          continue;
        }

        const existing = await db
          .select({ id: costEvents.id })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, row.id),
              eq(costEvents.biller, line.biller),
              eq(costEvents.model, line.model),
              eq(costEvents.billingType, RECURRING_FIXED_BILLING_TYPE),
              gte(costEvents.occurredAt, monthStart),
              lt(costEvents.occurredAt, monthEnd),
            ),
          )
          .limit(1)
          .then((r) => r[0] ?? null);

        if (existing) {
          result.skipped += 1;
          continue;
        }

        await db.insert(costEvents).values({
          companyId: row.id,
          agentId: attributionAgentId,
          provider: line.provider,
          biller: line.biller,
          billingType: RECURRING_FIXED_BILLING_TYPE,
          model: line.model,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costCents: line.monthlyCents,
          occurredAt: monthStart,
        });
        result.inserted += 1;

        logger.info(
          {
            companyId: row.id,
            biller: line.biller,
            model: line.model,
            costCents: line.monthlyCents,
          },
          "recurring-costs: inserted monthly cost_event",
        );
      }
    }

    return result;
  }

  function start() {
    void tickOnce().catch((err) => {
      logger.error({ err }, "recurring-costs: initial tick failed");
    });

    const timer = setInterval(() => {
      void tickOnce().catch((err) => {
        logger.error({ err }, "recurring-costs: tick failed");
      });
    }, RECURRING_COSTS_TICK_INTERVAL_MS);
    timer.unref?.();

    return () => clearInterval(timer);
  }

  return { tick: tickOnce, start };
}

export const RECURRING_COSTS_TICK_INTERVAL_MS = 60 * 60 * 1000;
