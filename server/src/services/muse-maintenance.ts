import { logger } from "../middleware/logger.js";
import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { museAgentBindings as bindings, museRunnerAssignments as assignments, mcpOauthGrants, type Db } from "@paperclipai/db";
import { museRunnerBroker } from "./muse-runner-broker.js";
import { museReceiver } from "./muse-receiver.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

export function startMuseMaintenance(
  db: Db,
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
) {
  const broker = museRunnerBroker(db);
  const receiver = museReceiver(db);
  let startupMarked = false;
  let requestedSweep = 0;
  let completedSweep = -1;
  let nextDeadline: number | null = null;
  const worker = coordinator.register(DELIVERY_QUEUES.museMaintenance, {
    retryMs: 5_000,
    pausePassiveMaintenance: true,
    onSettled: () => { requestedSweep++; },
    async run(signal) {
      const sweep = requestedSweep;
      if (!startupMarked) {
        await db.update(bindings).set({ cadenceEvidenceIncompleteAt: new Date() })
          .where(and(isNull(bindings.revokedAt), gt(bindings.qualificationExpiresAt, new Date())));
        startupMarked = true;
      }
      let failed = false;
      let after: string | undefined;
      while (!signal.aborted) {
        const expired = await db.select().from(bindings).where(and(
          isNull(bindings.revokedAt), lte(bindings.qualificationExpiresAt, new Date()),
          after ? gt(bindings.id, after) : undefined,
        )).orderBy(asc(bindings.id)).limit(100);
        for (const b of expired) {
          if (signal.aborted) return;
          if (!b.qualificationId) throw new Error("Muse qualification is missing its identity");
          try {
            await broker.endQualification({ companyId: b.companyId, agentId: b.agentId,
              bindingId: b.id, qualificationId: b.qualificationId, operatorId: b.operatorId });
          } catch {
            failed = true;
            logger.warn({ bindingId: b.id }, "Muse qualification deadline maintenance failed; will retry.");
          }
        }
        if (expired.length < 100) break;
        after = expired.at(-1)!.id;
      }
      after = undefined;
      while (!signal.aborted) {
        const active = await db.select().from(bindings).where(and(
          isNull(bindings.revokedAt), after ? gt(bindings.id, after) : undefined,
        )).orderBy(asc(bindings.id)).limit(100);
        for (const b of active) {
          if (signal.aborted) return;
          try {
            if (b.grantId) {
              const [grant] = await db.select({ revokedAt: mcpOauthGrants.revokedAt }).from(mcpOauthGrants)
                .where(and(eq(mcpOauthGrants.id, b.grantId), eq(mcpOauthGrants.companyId, b.companyId),
                  eq(mcpOauthGrants.agentId, b.agentId), eq(mcpOauthGrants.userId, b.operatorId)));
              if (!grant || grant.revokedAt) {
                await broker.revokeOAuthGrant({ grantId: b.grantId, companyId: b.companyId,
                  agentId: b.agentId, authorizingUserId: b.operatorId });
                continue;
              }
            }
            await broker.reconcileTerminalAssignments(b.companyId, b.agentId, b.id);
          } catch {
            failed = true;
            logger.warn({ bindingId: b.id }, "Muse authority or terminal reconciliation failed; will retry.");
          }
        }
        if (active.length < 100) break;
        after = active.at(-1)!.id;
      }
      if (failed) throw new Error("Muse maintenance has unfinished recovery");
      const [next] = await db.select({ at: bindings.qualificationExpiresAt }).from(bindings)
        .where(isNull(bindings.revokedAt))
        .orderBy(asc(bindings.qualificationExpiresAt)).limit(1);
      nextDeadline = next?.at?.getTime() ?? null;
      completedSweep = sweep;
    },
    async hasPending() {
      const [pending] = await db.select({ id: assignments.id }).from(assignments)
        .innerJoin(bindings, and(eq(bindings.id, assignments.bindingId),
          eq(bindings.companyId, assignments.companyId), eq(bindings.agentId, assignments.agentId),
          eq(bindings.generation, assignments.bindingGeneration), isNull(bindings.revokedAt)))
        .where(or(inArray(assignments.status, ["offered", "claimed", "accepted"]),
          and(eq(assignments.status, "settled"), isNull(assignments.finalizedAt))))
        .limit(1);
      return !!pending;
    },
    nextRunAt: () => completedSweep !== requestedSweep ? Date.now() + 5_000 : nextDeadline,
  });
  receiver.start();
  return Object.assign(() => receiver.stop(), { ready: worker.ready });
}
