import { and, count as countFn, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  heartbeatRuns,
} from "@paperclipai/db";
import type { InstanceGuardsConfig } from "@paperclipai/shared";

export interface BreakerTrip {
  reason: "wake_rate" | "same_issue_loop";
  detail: string;
  runCount: number;
  threshold: number;
}

async function ensureBreakerSentinelPolicy(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<string> {
  const existing = await db
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

  const raced = await db
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

  if (!raced) throw new Error(`Failed to upsert breaker sentinel policy for agent ${agentId}`);
  return raced.id;
}

async function pauseAgentForBreaker(
  db: Db,
  agentId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(agents)
    .set({ status: "paused", pauseReason: "budget", pausedAt: now, updatedAt: now })
    .where(and(eq(agents.id, agentId)));
}

async function openBreakerIncident(
  db: Db,
  companyId: string,
  agentId: string,
  policyId: string,
  trip: BreakerTrip,
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
        reason: trip.reason,
        detail: trip.detail,
        runCount: trip.runCount,
        threshold: trip.threshold,
        agentId,
        breakerTripped: true,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? null);

  await db.insert(budgetIncidents).values({
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
    amountObserved: trip.runCount,
    status: "open",
    approvalId: approval?.id ?? null,
  }).onConflictDoNothing();
}

export function runBreakerService(db: Db) {
  return {
    evaluate: async (
      companyId: string,
      agentId: string,
      issueId: string | null | undefined,
      guards: InstanceGuardsConfig,
    ): Promise<BreakerTrip | null> => {
      if (!guards.enabled) return null;

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      const [wakeRateRow] = await db
        .select({ cnt: countFn(heartbeatRuns.id) })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            gte(heartbeatRuns.createdAt, oneHourAgo),
          ),
        );
      const recentRunCount = Number(wakeRateRow?.cnt ?? 0);
      if (recentRunCount >= guards.breaker.maxRunsPerAgentPerHour) {
        return {
          reason: "wake_rate",
          detail: `Agent ran ${recentRunCount} times in the last hour (threshold: ${guards.breaker.maxRunsPerAgentPerHour})`,
          runCount: recentRunCount,
          threshold: guards.breaker.maxRunsPerAgentPerHour,
        };
      }

      if (issueId) {
        const recentSameIssueRuns = await db
          .select({
            id: heartbeatRuns.id,
            contextSnapshot: heartbeatRuns.contextSnapshot,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agentId),
              gte(heartbeatRuns.createdAt, oneHourAgo),
            ),
          )
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(guards.breaker.maxConsecutiveSameIssueRuns + 5);

        let consecutiveCount = 0;
        for (const run of recentSameIssueRuns) {
          const snapshot = run.contextSnapshot as Record<string, unknown> | null;
          const runIssueId = snapshot?.issueId;
          if (runIssueId === issueId) {
            consecutiveCount++;
          } else {
            break;
          }
        }

        if (consecutiveCount >= guards.breaker.maxConsecutiveSameIssueRuns) {
          return {
            reason: "same_issue_loop",
            detail: `Agent ran ${consecutiveCount} consecutive times on issue ${issueId} with no other work in between (threshold: ${guards.breaker.maxConsecutiveSameIssueRuns})`,
            runCount: consecutiveCount,
            threshold: guards.breaker.maxConsecutiveSameIssueRuns,
          };
        }
      }

      return null;
    },

    trip: async (
      companyId: string,
      agentId: string,
      trip: BreakerTrip,
    ): Promise<void> => {
      const policyId = await ensureBreakerSentinelPolicy(db, companyId, agentId);
      await pauseAgentForBreaker(db, agentId);
      await openBreakerIncident(db, companyId, agentId, policyId, trip);
    },
  };
}
