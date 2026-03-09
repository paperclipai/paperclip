import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import {
  TRUST_PROMOTION_THRESHOLD,
  TRUST_DEMOTION_FAILURE_THRESHOLD,
  TRUST_DEMOTION_WINDOW_SIZE,
  TRUST_MANUAL_OVERRIDE_COOLDOWN_MS,
  type TrustLevel,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

export function trustService(db: Db) {
  async function countConsecutiveSuccesses(agentId: string, threshold?: number): Promise<number> {
    const limit = threshold ?? TRUST_PROMOTION_THRESHOLD;
    const runs = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, ["succeeded", "failed"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.finishedAt))
      .limit(limit);

    let count = 0;
    for (const run of runs) {
      if (run.status === "failed" && run.errorCode === "process_lost") continue;
      if (run.status !== "succeeded") break;
      count++;
    }
    return count;
  }

  async function countRecentFailures(agentId: string): Promise<number> {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, ["succeeded", "failed"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.finishedAt))
      .limit(TRUST_DEMOTION_WINDOW_SIZE);

    return runs.filter(
      (r) => r.status === "failed" && r.errorCode !== "process_lost",
    ).length;
  }

  async function evaluateTrust(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ): Promise<void> {
    // Only evaluate on decisive outcomes
    if (outcome !== "succeeded" && outcome !== "failed") return;

    const agent = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        trustLevel: agents.trustLevel,
        trustPromotionThreshold: agents.trustPromotionThreshold,
        trustManuallySetAt: agents.trustManuallySetAt,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!agent) return;

    // Skip evaluation if trust was manually set in the last 5 minutes
    if (agent.trustManuallySetAt) {
      const fiveMinutesAgo = new Date(Date.now() - TRUST_MANUAL_OVERRIDE_COOLDOWN_MS);
      if (new Date(agent.trustManuallySetAt) > fiveMinutesAgo) return;
    }

    const threshold = agent.trustPromotionThreshold ?? TRUST_PROMOTION_THRESHOLD;

    if (outcome === "succeeded" && agent.trustLevel === "supervised") {
      const consecutive = await countConsecutiveSuccesses(agentId, threshold);
      if (consecutive >= threshold) {
        await promoteTrust(agentId, agent.companyId);
      }
    } else if (outcome === "failed" && agent.trustLevel === "autonomous") {
      const failures = await countRecentFailures(agentId);
      if (failures >= TRUST_DEMOTION_FAILURE_THRESHOLD) {
        await demoteTrust(agentId, agent.companyId);
      }
    }
  }

  async function promoteTrust(
    agentId: string,
    companyId: string,
  ): Promise<boolean> {
    const updated = await db
      .update(agents)
      .set({ trustLevel: "autonomous", updatedAt: new Date() })
      .where(
        and(eq(agents.id, agentId), eq(agents.trustLevel, "supervised")),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: agentId,
        action: "agent.trust_promoted",
        entityType: "agent",
        entityId: agentId,
        agentId,
        details: {
          from: "supervised",
          to: "autonomous",
          trigger: "automatic",
        },
      });
    }
    return !!updated;
  }

  async function demoteTrust(
    agentId: string,
    companyId: string,
  ): Promise<boolean> {
    const updated = await db
      .update(agents)
      .set({ trustLevel: "supervised", updatedAt: new Date() })
      .where(
        and(eq(agents.id, agentId), eq(agents.trustLevel, "autonomous")),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: agentId,
        action: "agent.trust_demoted",
        entityType: "agent",
        entityId: agentId,
        agentId,
        details: {
          from: "autonomous",
          to: "supervised",
          trigger: "automatic",
        },
      });
    }
    return !!updated;
  }

  async function setTrustLevel(
    agentId: string,
    companyId: string,
    trustLevel: TrustLevel,
    actorId: string,
  ): Promise<void> {
    const existing = await db
      .select({ trustLevel: agents.trustLevel })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    const now = new Date();
    await db
      .update(agents)
      .set({ trustLevel, trustManuallySetAt: now, updatedAt: now })
      .where(eq(agents.id, agentId));

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId,
      action:
        trustLevel === "autonomous"
          ? "agent.trust_promoted"
          : "agent.trust_demoted",
      entityType: "agent",
      entityId: agentId,
      agentId,
      details: {
        from: existing?.trustLevel ?? "unknown",
        to: trustLevel,
        trigger: "manual",
      },
    });
  }

  return {
    evaluateTrust,
    countConsecutiveSuccesses,
    countRecentFailures,
    setTrustLevel,
  };
}
