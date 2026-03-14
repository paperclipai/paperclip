import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

/**
 * Returns the current calendar month as "YYYY-MM".
 */
function currentYearMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Module-level tracking of the last month budgets were reset.
 * null = not yet initialized (will be set to current month on first call,
 * so a fresh server boot does NOT trigger an immediate reset).
 */
let lastResetMonth: string | null = null;

/**
 * Reset spentMonthlyCents to 0 for all agents and all companies.
 * Logs one activity event per company summarising the reset.
 * Safe to call multiple times (idempotent within the same month because
 * checkAndResetIfNewMonth guards the call).
 */
export async function resetMonthlyBudgetCounters(
  db: Db,
): Promise<{ agentsReset: number; companiesReset: number }> {
  // Reset all agents
  const updatedAgents = await db
    .update(agents)
    .set({ spentMonthlyCents: 0, updatedAt: new Date() })
    .returning({ id: agents.id });

  // Reset all companies and collect their ids for activity logging
  const updatedCompanies = await db
    .update(companies)
    .set({ spentMonthlyCents: 0, updatedAt: new Date() })
    .returning({ id: companies.id });

  // Log one activity event per company
  const month = currentYearMonth();
  for (const company of updatedCompanies) {
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "budget-reset",
      action: "budget.monthly_reset",
      entityType: "company",
      entityId: company.id,
      details: {
        month,
        agentsReset: updatedAgents.length,
        companiesReset: updatedCompanies.length,
      },
    });
  }

  return {
    agentsReset: updatedAgents.length,
    companiesReset: updatedCompanies.length,
  };
}

/**
 * Check whether the calendar month has rolled over since the last reset,
 * and if so, reset all monthly budget counters.
 *
 * On the very first call after server startup, lastResetMonth is initialised
 * to the current month without triggering a reset, so a fresh boot never
 * incorrectly resets mid-month data.
 */
export async function checkAndResetIfNewMonth(
  db: Db,
): Promise<{ reset: boolean; month: string }> {
  const month = currentYearMonth();

  if (lastResetMonth === null) {
    // First call — record current month; no reset needed.
    lastResetMonth = month;
    return { reset: false, month };
  }

  if (lastResetMonth === month) {
    return { reset: false, month };
  }

  // Month has changed — perform reset.
  await resetMonthlyBudgetCounters(db);
  lastResetMonth = month;
  return { reset: true, month };
}

/**
 * Exposed for testing: override the internally tracked last-reset month.
 * Do not call from production code.
 */
export function _setLastResetMonthForTesting(month: string | null): void {
  lastResetMonth = month;
}
