import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export const BUDGET_WARNING_THRESHOLD = 0.8; // 80%
export const BUDGET_EXCEEDED_THRESHOLD = 1.0; // 100%

export type BudgetLevel = "ok" | "warning" | "exceeded";

export interface BudgetCheckResult {
  allowed: boolean;
  level: BudgetLevel;
  agentUtilization: number | null; // null if no agent budget set
  companyUtilization: number | null; // null if no company budget set
  reason?: string;
}

export async function checkBudgetGate(
  db: Db,
  agent: typeof agents.$inferSelect,
): Promise<BudgetCheckResult> {
  // Check agent-level budget
  let agentUtilization: number | null = null;
  if (agent.budgetMonthlyCents > 0) {
    agentUtilization = agent.spentMonthlyCents / agent.budgetMonthlyCents;
  }

  // Check company-level budget
  const company = await db
    .select({ budgetMonthlyCents: companies.budgetMonthlyCents, spentMonthlyCents: companies.spentMonthlyCents })
    .from(companies)
    .where(eq(companies.id, agent.companyId))
    .then((rows) => rows[0] ?? null);

  let companyUtilization: number | null = null;
  if (company && company.budgetMonthlyCents > 0) {
    companyUtilization = company.spentMonthlyCents / company.budgetMonthlyCents;
  }

  // Check if either budget is exceeded (100%)
  if (agentUtilization !== null && agentUtilization >= BUDGET_EXCEEDED_THRESHOLD) {
    return {
      allowed: false,
      level: "exceeded",
      agentUtilization,
      companyUtilization,
      reason: `Agent budget exceeded: ${formatPercent(agentUtilization)} of ${formatCents(agent.budgetMonthlyCents)} used`,
    };
  }
  if (companyUtilization !== null && companyUtilization >= BUDGET_EXCEEDED_THRESHOLD) {
    return {
      allowed: false,
      level: "exceeded",
      agentUtilization,
      companyUtilization,
      reason: `Company budget exceeded: ${formatPercent(companyUtilization)} of ${formatCents(company!.budgetMonthlyCents)} used`,
    };
  }

  // Check warning level (80%)
  const isWarning =
    (agentUtilization !== null && agentUtilization >= BUDGET_WARNING_THRESHOLD) ||
    (companyUtilization !== null && companyUtilization >= BUDGET_WARNING_THRESHOLD);

  return {
    allowed: true,
    level: isWarning ? "warning" : "ok",
    agentUtilization,
    companyUtilization,
    reason: isWarning
      ? `Budget warning: agent ${formatPercent(agentUtilization ?? 0)}, company ${formatPercent(companyUtilization ?? 0)}`
      : undefined,
  };
}

/**
 * Log a budget event to the activity log. Call this when budget level transitions to warning or exceeded.
 */
export async function logBudgetEvent(
  db: Db,
  agent: typeof agents.$inferSelect,
  result: BudgetCheckResult,
) {
  const action = result.level === "exceeded" ? "budget.exceeded" : "budget.warning";
  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "system",
    actorId: "budget-guard",
    action,
    entityType: "agent",
    entityId: agent.id,
    agentId: agent.id,
    details: {
      level: result.level,
      agentUtilization: result.agentUtilization,
      companyUtilization: result.companyUtilization,
      reason: result.reason,
    },
  });
}

/**
 * Check if agent has a budget override (board explicitly approved continuing past budget).
 * Override is stored in agent.metadata.budgetOverride = true.
 */
export function hasBudgetOverride(agent: typeof agents.$inferSelect): boolean {
  const metadata = agent.metadata as Record<string, unknown> | null;
  return metadata?.budgetOverride === true;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
