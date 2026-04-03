import { and, eq, isNull, ne, lte, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { agents, agentMemoryEntries, issues } from "@ironworksai/db";
import type { TerminationReason } from "@ironworksai/shared";
import { logActivity } from "./activity-log.js";
import { archiveAgentWorkspace } from "./agent-workspace.js";
import { createTerminationRecord } from "./hr-personnel.js";
import { logger } from "../middleware/logger.js";

// ── Contractor Lifecycle Check ──────────────────────────────────────────────
//
// Runs hourly. Finds all active contractor agents and evaluates their
// termination conditions. Terminates or pauses as appropriate and logs
// activity entries for each state change.

async function terminateContractor(
  db: Db,
  agent: { id: string; companyId: string; name: string },
  reason: TerminationReason,
): Promise<void> {
  const now = new Date();

  await db.transaction(async (tx) => {
    // Mark agent terminated
    await tx
      .update(agents)
      .set({
        status: "terminated",
        terminatedAt: now,
        terminationReason: reason,
        updatedAt: now,
      })
      .where(eq(agents.id, agent.id));

    // Archive all active memory entries
    await tx
      .update(agentMemoryEntries)
      .set({ archivedAt: now })
      .where(
        and(
          eq(agentMemoryEntries.agentId, agent.id),
          isNull(agentMemoryEntries.archivedAt),
        ),
      );
  });

  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "system",
    actorId: "contractor-lifecycle",
    action: "agent.terminated",
    entityType: "agent",
    entityId: agent.id,
    details: {
      agentName: agent.name,
      terminationReason: reason,
      employmentType: "contractor",
    },
  });

  // Archive workspace and create termination record (best-effort)
  try {
    await archiveAgentWorkspace(db, agent.id);
    await createTerminationRecord(db, {
      companyId: agent.companyId,
      hrAgentId: null,
      terminatedAgentId: agent.id,
      terminatedAgentName: agent.name,
      reason,
    });
  } catch (err) {
    logger.error({ agentId: agent.id, err }, "failed to archive workspace or create termination record");
  }

  logger.info(
    { agentId: agent.id, agentName: agent.name, reason },
    "contractor agent terminated",
  );
}

/**
 * Check all active contractor agents for termination conditions.
 *
 * Conditions evaluated:
 *   - date: contract_end_at has passed
 *   - budget_exhausted: contract_spent_cents >= contract_budget_cents (with 24h grace)
 *   - project_complete: all issues in the contract project are done or cancelled
 *
 * Returns the number of agents terminated in this run.
 */
export async function checkContractorLifecycles(db: Db): Promise<number> {
  const now = new Date();

  // 1. Fetch all active contractors (not already terminated)
  const contractors = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      contractEndCondition: agents.contractEndCondition,
      contractEndAt: agents.contractEndAt,
      contractBudgetCents: agents.contractBudgetCents,
      contractSpentCents: agents.contractSpentCents,
      contractProjectId: agents.contractProjectId,
      pausedAt: agents.pausedAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.employmentType, "contractor"),
        ne(agents.status, "terminated"),
        isNull(agents.terminatedAt),
      ),
    );

  let terminatedCount = 0;

  for (const contractor of contractors) {
    const { id, companyId, name, contractEndCondition } = contractor;
    const agentRef = { id, companyId, name };

    // ── Date-based termination ──────────────────────────────────────
    if (contractEndCondition === "date" && contractor.contractEndAt) {
      if (now >= contractor.contractEndAt) {
        await terminateContractor(db, agentRef, "deadline_reached");
        terminatedCount++;
        continue;
      }
    }

    // ── Budget-based termination (with 24h grace period) ────────────
    if (contractEndCondition === "budget_exhausted") {
      const budget = contractor.contractBudgetCents ?? 0;
      const spent = contractor.contractSpentCents ?? 0;

      if (budget > 0 && spent >= budget) {
        if (contractor.status !== "paused") {
          // First time over budget - pause with grace period
          await db
            .update(agents)
            .set({
              status: "paused",
              pauseReason: "Budget exhausted - 24h grace period",
              pausedAt: now,
              updatedAt: now,
            })
            .where(eq(agents.id, id));

          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "contractor-lifecycle",
            action: "agent.paused",
            entityType: "agent",
            entityId: id,
            details: {
              agentName: name,
              reason: "budget_exhausted_grace",
              contractBudgetCents: budget,
              contractSpentCents: spent,
            },
          });

          logger.info(
            { agentId: id, agentName: name, budget, spent },
            "contractor paused - budget exhausted, 24h grace period started",
          );
        } else if (contractor.pausedAt) {
          // Already paused - check if 24h grace period has elapsed
          const gracePeriodMs = 24 * 60 * 60 * 1000;
          const pausedSinceMs = now.getTime() - contractor.pausedAt.getTime();

          if (pausedSinceMs >= gracePeriodMs) {
            await terminateContractor(db, agentRef, "budget_exhausted");
            terminatedCount++;
            continue;
          }
        }
      }
    }

    // ── Project-complete termination ────────────────────────────────
    if (contractEndCondition === "project_complete" && contractor.contractProjectId) {
      const projectIssues = await db
        .select({
          total: sql<number>`count(*)::int`,
          terminal: sql<number>`count(case when ${issues.status} in ('done', 'cancelled') then 1 end)::int`,
        })
        .from(issues)
        .where(eq(issues.projectId, contractor.contractProjectId));

      const row = projectIssues[0];
      const total = Number(row?.total ?? 0);
      const terminal = Number(row?.terminal ?? 0);

      // Only terminate if the project has issues and ALL are done/cancelled
      if (total > 0 && terminal === total) {
        await terminateContractor(db, agentRef, "contract_complete");
        terminatedCount++;
        continue;
      }
    }
  }

  return terminatedCount;
}
