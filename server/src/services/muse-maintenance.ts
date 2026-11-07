import { pendingMuseTerminalBindings, type ExternalAgentSettlementScope } from "../modules/external-agents/index.js";
import { logger } from "../middleware/logger.js";
import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import { museAgentBindings as bindings, mcpOauthGrants, type Db } from "@paperclipai/db";
import { museRunnerBroker } from "./muse-runner-broker.js";
import { museReceiver } from "./muse-receiver.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

export function startMuseMaintenance(
  db: Db,
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  canSettle: () => Promise<boolean> = async () => true,
) {
  const broker = museRunnerBroker(db);
  const receiver = museReceiver(db);
  let startupMarked = false;
  const requested = new Set<string>(["*"]);
  let nextDeadline: number | null = null;
  const worker = coordinator.register(DELIVERY_QUEUES.museMaintenance, {
    retryMs: 5_000,
    pausePassiveMaintenance: true,
    onSettled: hints => { for (const hint of hints ?? ["*"]) requested.add(hint); },
    async run(signal) {
      if (nextDeadline !== null && nextDeadline <= Date.now()) requested.add("*");
      const hints = [...requested];
      for (const hint of hints) requested.delete(hint);
      try {
        const global = hints.includes("*");
        const settlementAllowed = await canSettle();
        const inspected = new Set<string>();
        if (!startupMarked) {
          await db.update(bindings).set({ cadenceEvidenceIncompleteAt: new Date() })
            .where(and(isNull(bindings.revokedAt), gt(bindings.qualificationExpiresAt, new Date())));
          startupMarked = true;
        }
        let failed = false;
        let after: string | undefined;
        if (global) {
          while (!signal.aborted) {
            const expired = await db.select().from(bindings).where(and(
              isNull(bindings.revokedAt), lte(bindings.qualificationExpiresAt, new Date()),
              after ? gt(bindings.id, after) : undefined,
            )).orderBy(asc(bindings.id)).limit(100);
            for (const b of expired) {
              if (signal.aborted) throw new Error("Muse maintenance stopped");
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
              if (signal.aborted) throw new Error("Muse maintenance stopped");
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
                if (settlementAllowed) {
                  await broker.reconcileTerminalAssignments(b.companyId, b.agentId, b.id, { limit: 100 });
                  inspected.add(b.id);
                }
              } catch {
                failed = true;
                logger.warn({ bindingId: b.id }, "Muse authority or terminal reconciliation failed; will retry.");
              }
            }
            if (active.length < 100) break;
            after = active.at(-1)!.id;
          }
        }
        if (settlementAllowed) {
          for (const hint of global ? ["*"] : hints) {
            const scope: ExternalAgentSettlementScope | undefined = hint === "*" ? undefined : JSON.parse(hint);
            let after: string | undefined;
            while (!signal.aborted) {
              const pending = await pendingMuseTerminalBindings(db, scope, after);
              for (const binding of pending) {
                if (signal.aborted) throw new Error("Muse settlement stopped");
                if (inspected.has(binding.id)) continue;
                try { await broker.reconcileTerminalAssignments(binding.companyId, binding.agentId, binding.id, { limit: 100 }); }
                catch (error) { failed = true; logger.warn({ err: error, bindingId: binding.id }, "Muse settlement failed; will retry."); }
              }
              if (pending.length < 100) break;
              after = pending.at(-1)!.id;
            }


            if ((await pendingMuseTerminalBindings(db, scope)).length) requested.add(hint);
          }
        }
        if (signal.aborted) throw new Error("Muse maintenance stopped");
        if (failed) throw new Error("Muse maintenance has unfinished recovery");
        if (global) {
          const [next] = await db.select({ at: bindings.qualificationExpiresAt }).from(bindings)
            .where(isNull(bindings.revokedAt))
            .orderBy(asc(bindings.qualificationExpiresAt)).limit(1);
          nextDeadline = next?.at?.getTime() ?? null;
        }
      } catch (error) {
        for (const hint of hints) requested.add(hint);
        throw error;
      }
    },

    hasPending: async () => false,
    nextRunAt: () => requested.size ? Math.min(Date.now() + 5_000, nextDeadline ?? Infinity) : nextDeadline,
  });
  receiver.start();
  return Object.assign(() => receiver.stop(), { ready: worker.ready });
}
