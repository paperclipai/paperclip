import { HttpError } from "../errors.js";
import { museIdentity, inspectMuseConnectionCredential } from "./muse-identity.js";
import { canConfigureAgentConnection } from "../modules/agent-lifecycle/index.js";
import { recoverMuseReceiverContinuity, pendingMuseContactVerifications, parseMuseVerificationHint, type MuseVerificationScope, pendingMuseTerminalBindings, type ExternalAgentSettlementScope } from "../modules/external-agents/index.js";
import { logger } from "../middleware/logger.js";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
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
  type StartupQualification = Pick<typeof bindings.$inferSelect, "id" | "companyId" | "generation" | "revision" | "qualificationId">;
  let startupSnapshot: Promise<StartupQualification[]> | undefined;
  function initialQualifications(signal: AbortSignal) {
    // Both owners join this SQL-only snapshot before local duties can mutate
    // qualifications. Commit it before any Cloud I/O; retry never widens it.
    return startupSnapshot ??= db.transaction(async tx => {
      const snapshot: StartupQualification[] = [];
      const at = new Date();
      let after: string | undefined;
      while (!signal.aborted) {
        const page = await tx.select({ id: bindings.id, companyId: bindings.companyId,
          generation: bindings.generation, revision: bindings.revision, qualificationId: bindings.qualificationId })
          .from(bindings).where(and(isNull(bindings.revokedAt), gt(bindings.qualificationExpiresAt, at),
            after ? gt(bindings.id, after) : undefined)).orderBy(asc(bindings.id)).limit(100);
        snapshot.push(...page);
        if (page.length < 100) return snapshot;
        after = page.at(-1)!.id;
      }
      signal.throwIfAborted();
      return snapshot;
    }, { isolationLevel: "repeatable read", accessMode: "read only" }).catch(error => {
      startupSnapshot = undefined;
      throw error;
    });
  }
  const continuity = coordinator.register(DELIVERY_QUEUES.museContinuity, {
    retryMs: 5_000,
    pausePassiveMaintenance: true,
    async run(signal) {
      if (startupMarked) return;
      const initial = await initialQualifications(signal);
      signal.throwIfAborted();
      const continuous = await recoverMuseReceiverContinuity(db, signal);
      signal.throwIfAborted();
      // Keep the original startup UPDATE even for an empty cohort. A failed
      // evidence write remains unresolved; it cannot complete startup recovery.
      for (let offset = 0; offset < Math.max(1, initial.length); offset += 100) {
        signal.throwIfAborted();
        const unowned = initial.slice(offset, offset + 100).filter(b => continuous.get(b.id) !== b.generation);
        const exact = unowned.map(b => sql`(${bindings.id} = ${b.id} and ${bindings.companyId} = ${b.companyId}
          and ${bindings.generation} = ${b.generation} and ${bindings.revision} = ${b.revision}
          and ${b.qualificationId === null ? isNull(bindings.qualificationId) : eq(bindings.qualificationId, b.qualificationId)})`);
        await db.update(bindings).set({ cadenceEvidenceIncompleteAt: new Date() })
          .where(and(isNull(bindings.revokedAt), gt(bindings.qualificationExpiresAt, new Date()),
            exact.length ? sql`(${sql.join(exact, sql` or `)})` : sql`false`));
      }
      startupMarked = true;
    },
    hasPending: async () => false,
    nextRunAt: () => startupMarked ? null : Date.now() + 5_000,
  });
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
        await initialQualifications(signal);
        signal.throwIfAborted();
        const settlementAllowed = await canSettle();
        const inspected = new Set<string>();
        let failed = false;
        let verificationEnabled: boolean | undefined;
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
        for (const hint of global ? ["*"] : hints) {
          const scope: MuseVerificationScope | undefined = hint === "*" ? undefined : parseMuseVerificationHint(hint);
          if (hint !== "*" && !scope) continue;
          let after: string | undefined;
          while (!signal.aborted) {
            const rows = await pendingMuseContactVerifications(db, scope, after);
            for (const { binding: b, agent } of rows) {
              if (signal.aborted) throw new Error("Muse verification recovery stopped");
              if (!canConfigureAgentConnection(agent)) continue;
              verificationEnabled ??= await museIdentity(db).enabled();
              if (!verificationEnabled) break;
              if (!settlementAllowed) { requested.add(hint); continue; }
              try {
                const credential = await inspectMuseConnectionCredential(db, b);
                if (credential.state !== "active" && credential.state !== "pending") continue;
                await broker.verify(b.companyId, b.agentId, {
                  bindingId: b.id, generation: b.generation, expectedRevision: b.revision,
                });
              } catch (error) {
                if (!(error instanceof HttpError && [401, 403, 404, 410].includes(error.status))) {
                  failed = true;
                  requested.add(hint);
                }
              }
            }
            if (rows.length < 100 || verificationEnabled === false) break;
            after = rows.at(-1)!.binding.id;
          }
          if (verificationEnabled === false) break;
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
        if (global) {
          const [next] = await db.select({ at: bindings.qualificationExpiresAt }).from(bindings)
            .where(and(isNull(bindings.revokedAt), gt(bindings.qualificationExpiresAt, new Date())))
            .orderBy(asc(bindings.qualificationExpiresAt)).limit(1);
          nextDeadline = next?.at?.getTime() ?? null;
        }
        if (failed) throw new Error("Muse maintenance has unfinished recovery");
      } catch (error) {
        for (const hint of hints) requested.add(hint);
        throw error;
      }
    },

    hasPending: async () => false,
    nextRunAt: () => requested.size ? Math.min(Date.now() + 5_000, nextDeadline ?? Infinity) : nextDeadline,
  });
  receiver.start();
  return Object.assign(async () => {
    const stopped = await Promise.allSettled([
      () => continuity.stop(), () => worker.stop(), () => receiver.stop(),
    ].map(stopOwner => Promise.resolve().then(stopOwner)));
    const failures = stopped.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Muse maintenance shutdown failed");
  }, { ready: worker.ready });
}
