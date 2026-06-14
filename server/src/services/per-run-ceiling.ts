import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
} from "@paperclipai/db";

// G3 — per-run token ceiling. The windowed monthly budget (G2) catches slow
// bleed and the breaker (G4) catches tight loops, but a single pathological run
// that burns far more than a normal turn — yet less than the monthly cap — slips
// through both. This guard enforces a per-run token ceiling *post-run*: once a
// finished run's total tokens exceed the ceiling, the agent is paused and an
// incident is opened, exactly like the budget hard-stop, so the next run cannot
// proceed without operator review.
//
// NOTE: this is post-run enforcement, not a mid-flight kill. The adapter runs as
// a subprocess and emits no streaming usage, so per-run tokens are only known
// after the run finishes. A true mid-flight cancel would require the adapter
// protocol to stream usage during execution — out of scope here.

export interface PerRunCeilingFault {
  reason: "per_run_ceiling";
  detail: string;
  runTotalTokens: number;
  ceiling: number;
}

async function ensureCeilingSentinelPolicy(
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
    throw new Error(`Failed to upsert per-run-ceiling sentinel policy for agent ${agentId}`);
  }
  return raced.id;
}

async function pauseAgentForCeiling(db: Db, agentId: string): Promise<void> {
  const now = new Date();
  await db
    .update(agents)
    // pauseReason reuses "budget" (PAUSE_REASONS has no dedicated per-run value);
    // the real cause is carried on the incident payload.
    .set({ status: "paused", pauseReason: "budget", pausedAt: now, updatedAt: now })
    .where(eq(agents.id, agentId));
}

async function openCeilingIncident(
  db: Db,
  companyId: string,
  agentId: string,
  policyId: string,
  fault: PerRunCeilingFault,
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
        runTotalTokens: fault.runTotalTokens,
        ceiling: fault.ceiling,
        agentId,
        perRunCeilingExceeded: true,
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
      amountLimit: fault.ceiling,
      amountObserved: fault.runTotalTokens,
      status: "open",
      approvalId: approval?.id ?? null,
    })
    .onConflictDoNothing();
}

export function perRunCeilingService(db: Db) {
  return {
    // Returns a fault when a finished run's token total exceeds the ceiling.
    // ceiling <= 0 disables the check (returns null).
    evaluate: (runTotalTokens: number, ceiling: number): PerRunCeilingFault | null => {
      if (ceiling <= 0) return null;
      if (runTotalTokens <= ceiling) return null;
      return {
        reason: "per_run_ceiling",
        detail:
          `Run used ${runTotalTokens} tokens, exceeding the per-run ceiling of ${ceiling}. ` +
          "Agent paused for operator review.",
        runTotalTokens,
        ceiling,
      };
    },

    trip: async (
      companyId: string,
      agentId: string,
      fault: PerRunCeilingFault,
    ): Promise<void> => {
      const policyId = await ensureCeilingSentinelPolicy(db, companyId, agentId);
      await pauseAgentForCeiling(db, agentId);
      await openCeilingIncident(db, companyId, agentId, policyId, fault);
    },
  };
}

// G3 turns clamp (pure) — the effective per-run turn cap is the tighter of the
// agent's configured value and the platform guard floor. An agent configured
// below the floor keeps its tighter cap; an unset/non-positive agent value
// (including the portability default of 1000) is clamped to the floor.
export function resolveEffectiveMaxTurns(
  agentMaxTurns: number | null | undefined,
  guardMaxTurns: number,
): number {
  if (guardMaxTurns <= 0) return typeof agentMaxTurns === "number" && agentMaxTurns > 0 ? agentMaxTurns : guardMaxTurns;
  const agentTurns = typeof agentMaxTurns === "number" && agentMaxTurns > 0 ? agentMaxTurns : Infinity;
  return Math.min(agentTurns, guardMaxTurns);
}
