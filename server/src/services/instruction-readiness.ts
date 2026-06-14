import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
} from "@paperclipai/db";

// W1 — instruction-readiness gate. A managed-bundle agent whose instruction
// bundle is empty would invoke the adapter with no instructions and burn tokens
// flailing (B1: an Architect with an empty bundle spent ~1.17M tokens producing
// nothing). This service pauses such an agent and opens an incident, mirroring
// the run-breaker pause/incident flow so it lands in the same operator
// resume surface. It never invokes the adapter.

export interface InstructionReadinessFault {
  reason: "instructions_empty";
  detail: string;
}

// Sentinel policy gives the incident a policyId to hang from without a real
// token budget (amount 0, inactive). Mirrors run-breaker's sentinel so the
// two guards can share an agent's incident surface without colliding.
async function ensureReadinessSentinelPolicy(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<string> {
  const find = () =>
    db
      .select({ id: budgetPolicies.id })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "agent"),
          eq(budgetPolicies.scopeId, agentId),
          eq(budgetPolicies.metric, "total_tokens"),
          eq(budgetPolicies.windowKind, "lifetime"),
        ),
      )
      .then((rows) => rows[0] ?? null);

  const existing = await find();
  if (existing) return existing.id;

  const [created] = await db
    .insert(budgetPolicies)
    .values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "total_tokens",
      windowKind: "lifetime",
      amount: 0,
      isActive: false,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created.id;

  const raced = await find();
  if (!raced) {
    throw new Error(`Failed to upsert readiness sentinel policy for agent ${agentId}`);
  }
  return raced.id;
}

async function pauseAgentForReadiness(db: Db, agentId: string): Promise<void> {
  const now = new Date();
  await db
    .update(agents)
    // pauseReason reuses the "budget" value (PAUSE_REASONS has no dedicated
    // readiness reason); the real cause is carried on the incident payload.
    .set({ status: "paused", pauseReason: "budget", pausedAt: now, updatedAt: now })
    .where(eq(agents.id, agentId));
}

async function openReadinessIncident(
  db: Db,
  companyId: string,
  agentId: string,
  policyId: string,
  fault: InstructionReadinessFault,
): Promise<void> {
  const now = new Date();
  const distantFuture = new Date("2099-01-01T00:00:00Z");

  const approval = await db
    .insert(approvals)
    .values({
      companyId,
      type: "budget_override_required",
      requestedByUserId: null,
      requestedByAgentId: null,
      status: "pending",
      payload: {
        reason: fault.reason,
        detail: fault.detail,
        agentId,
        instructionsEmpty: true,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? null);

  await db
    .insert(budgetIncidents)
    .values({
      companyId,
      policyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "total_tokens",
      windowKind: "lifetime",
      windowStart: now,
      windowEnd: distantFuture,
      thresholdType: "hard",
      amountLimit: 0,
      amountObserved: 0,
      status: "open",
      approvalId: approval?.id ?? null,
    })
    .onConflictDoNothing();
}

export function instructionReadinessService(db: Db) {
  return {
    // Returns a fault when the agent's managed bundle is empty, else null.
    // The emptiness probe is supplied by the caller (agent-instructions
    // isManagedBundleEmpty) so this service stays db-only and unit-testable.
    evaluate: (bundleEmpty: boolean): InstructionReadinessFault | null => {
      if (!bundleEmpty) return null;
      return {
        reason: "instructions_empty",
        detail:
          "Agent has a managed instruction bundle with no instruction files; refusing to invoke the adapter with empty instructions.",
      };
    },

    trip: async (
      companyId: string,
      agentId: string,
      fault: InstructionReadinessFault,
    ): Promise<void> => {
      const policyId = await ensureReadinessSentinelPolicy(db, companyId, agentId);
      await pauseAgentForReadiness(db, agentId);
      await openReadinessIncident(db, companyId, agentId, policyId, fault);
    },
  };
}
